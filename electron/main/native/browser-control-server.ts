// Loopback TCP server bridging the Rust MCP (`verne mcp`) to the in-process CDP
// sessions. Protocol: one JSON line in {action, ...args, secret, workspaceDir},
// one JSON line out {ok:true,...} | {ok:false,error}. Writes {port,secret} to
// browser-control.json so the MCP can find it.
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { internalDataDir } from "../paths";
import type { BrowserRegistry } from "./browser-registry";
import { normalizeBrowserUrl, sameBrowserUrl } from "../../../src/lib/browserTabs";
import type { AutomationBrowserSession } from "./browser-automation-window";

// PATH PARITY: must equal Rust crate::paths::browser_control_file()
// = internal_data_dir()/browser-control.json. The agent's `verne mcp` inherits
// VERNE_INTERNAL_DATA_DIR (set on the daemon, inherited through the PTY), which
// internal_data_dir() honors — so the dir is exactly `internalDataDir` here.
export function browserControlFilePath(): string {
  return path.join(internalDataDir, "browser-control.json");
}

interface Options {
  secret?: string;
  writeDescriptor?: boolean;
  createAutomationSession?: (tabId: string, url: string, workspaceDir: string) => Promise<AutomationBrowserSession>;
}

export class BrowserControlServer {
  private server?: net.Server;
  private secret: string;
  private writeDescriptor: boolean;
  private createAutomationSession?: Options["createAutomationSession"];

  constructor(
    private registry: BrowserRegistry,
    opts: Options = {},
  ) {
    this.secret = opts.secret ?? crypto.randomBytes(24).toString("hex");
    this.writeDescriptor = opts.writeDescriptor ?? true;
    this.createAutomationSession = opts.createAutomationSession;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((c) => this.onConn(c));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const port = (this.server!.address() as net.AddressInfo).port;
        if (this.writeDescriptor) {
          const file = browserControlFilePath();
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ port, secret: this.secret }), { mode: 0o600 });
        }
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    if (this.writeDescriptor) { try { fs.unlinkSync(browserControlFilePath()); } catch { /* ignore */ } }
  }

  private onConn(c: net.Socket): void {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      this.handle(line)
        .then((resp) => c.end(JSON.stringify(resp) + "\n"))
        .catch((e) => c.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + "\n"));
    });
    c.on("error", () => { /* client gone */ });
  }

  private async handle(line: string): Promise<object> {
    let req: any;
    try { req = JSON.parse(line); } catch { return { ok: false, error: "bad json" }; }
    if (req.secret !== this.secret) return { ok: false, error: "auth failed" };
    const ws = req.workspaceDir as string;
    try {
      switch (req.action) {
        case "list":
          return { ok: true, browsers: this.registry.list(ws) };
        case "current":
          return { ok: true, browser: this.registry.currentUi(ws) };
        case "open": {
          const target = normalizeBrowserUrl(req.url);
          const automationOwner = this.automationOwner(req.automationOwner, ws);
          const owned = this.registry.findAutomationByOwner(ws, automationOwner);
          if (owned) {
            if (!sameBrowserUrl(owned.currentUrl(), target)) {
              await owned.navigate(target);
            }
            return { ok: true, tabId: owned.tabId, reused: true };
          }
          const tabId = await this.openAutomationTab(target, ws, automationOwner);
          return { ok: true, tabId, reused: false };
        }
        case "navigate": {
          const url = await this.registry.get(req.tabId, ws).navigate(req.url);
          return { ok: true, url };
        }
        case "back":
          await this.history(req.tabId, ws, -1);
          return { ok: true };
        case "forward":
          await this.history(req.tabId, ws, +1);
          return { ok: true };
        case "reload":
          await this.registry.get(req.tabId, ws).send("Page.reload");
          return { ok: true };
        case "snapshot": {
          const snap = await this.registry.get(req.tabId, ws).snapshot();
          return { ok: true, snapshot: JSON.stringify(snap) };
        }
        case "click":
          await this.registry.get(req.tabId, ws).click(req.ref);
          return { ok: true };
        case "fill":
          await this.registry.get(req.tabId, ws).fill(req.ref, req.value);
          return { ok: true };
        case "select":
          await this.registry.get(req.tabId, ws).selectOption(req.ref, req.value);
          return { ok: true };
        case "screenshot": {
          const jpegBase64 = await this.registry.get(req.tabId, ws).screenshotJpeg();
          return { ok: true, jpegBase64 };
        }
        case "network":
          return { ok: true, requests: this.registry.get(req.tabId, ws).networkRequests() };
        case "console":
          return { ok: true, messages: this.registry.get(req.tabId, ws).consoleMessages() };
        case "wait":
          await this.registry.get(req.tabId, ws).waitFor(req.until, req.timeoutMs);
          return { ok: true };
        default:
          return { ok: false, error: `unknown action ${req.action}` };
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  private async history(tabId: string, ws: string, delta: number): Promise<void> {
    const s = this.registry.get(tabId, ws);
    const { currentIndex, entries } = await s.send("Page.getNavigationHistory");
    const target = entries[currentIndex + delta];
    if (!target) throw new Error(delta < 0 ? "no back history" : "no forward history");
    await s.send("Page.navigateToHistoryEntry", { entryId: target.id });
  }

  private automationOwner(raw: unknown, ws: string): string {
    return typeof raw === "string" && raw.trim() ? raw.trim() : `workspace:${ws}`;
  }

  private async openAutomationTab(url: string, ws: string, automationOwner: string): Promise<string> {
    if (!this.createAutomationSession) throw new Error("browser automation unavailable");
    const tabId = `browser:${crypto.randomUUID()}`;
    const { session, dispose } = await this.createAutomationSession(tabId, url, ws);
    this.registry.registerAutomation(tabId, session, automationOwner, dispose);
    return tabId;
  }
}
