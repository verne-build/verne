import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { BrowserControlServer } from "./browser-control-server";

let srv: BrowserControlServer | undefined;
afterEach(async () => { await srv?.stop(); srv = undefined; });

function rpc(port: number, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(JSON.stringify(body) + "\n"));
    let buf = "";
    c.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) { resolve(JSON.parse(buf)); c.end(); } });
    c.on("error", reject);
  });
}

function fakeRegistry() {
  const session = {
    navigate: vi.fn(async () => "http://x/landed"),
    snapshot: vi.fn(async () => ({ url: "http://x", title: "T", count: 0, elements: [] })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    networkRequests: vi.fn(() => [{ requestId: "1", url: "http://x", status: 200 }]),
    consoleMessages: vi.fn(() => [{ type: "log", text: "hi" }]),
  };
  return {
    session,
    get: vi.fn(() => session),
    list: vi.fn(() => [{ id: "browser:a", url: "" }]),
    has: vi.fn(() => true),
    setActive: vi.fn(),
  };
}

const noWin = () => ({} as any);
const opts = { secret: "good", writeDescriptor: false };

describe("BrowserControlServer", () => {
  it("rejects a bad secret", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, noWin, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "list", secret: "bad", workspaceDir: "/ws" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/auth/i);
  });

  it("rejects bad json", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, noWin, opts);
    const port = await srv.start();
    const resp = await new Promise<any>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () => c.write("not json\n"));
      let buf = ""; c.on("data", (d) => { buf += d; if (buf.includes("\n")) { resolve(JSON.parse(buf)); c.end(); } });
    });
    expect(resp).toEqual({ ok: false, error: "bad json" });
  });

  it("dispatches snapshot for a valid secret", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, noWin, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "snapshot", tabId: "browser:a", secret: "good", workspaceDir: "/ws" });
    expect(resp.ok).toBe(true);
    expect(JSON.parse(resp.snapshot).title).toBe("T");
  });

  it("serves network + console buffers", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, noWin, opts);
    const port = await srv.start();
    const n = await rpc(port, { action: "network", tabId: "browser:a", secret: "good", workspaceDir: "/ws" });
    expect(n.requests[0].status).toBe(200);
    const con = await rpc(port, { action: "console", tabId: "browser:a", secret: "good", workspaceDir: "/ws" });
    expect(con.messages[0].text).toBe("hi");
  });

  it("returns the navigated url", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, noWin, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "navigate", tabId: "browser:a", url: "http://x", secret: "good", workspaceDir: "/ws" });
    expect(resp).toEqual({ ok: true, url: "http://x/landed" });
  });

  it("reports a clean error when the session throws", async () => {
    const reg = fakeRegistry();
    reg.get = vi.fn(() => { throw new Error("tab browser:a not in workspace"); });
    srv = new BrowserControlServer(reg as any, noWin, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "snapshot", tabId: "browser:a", secret: "good", workspaceDir: "/other" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/not in workspace/);
  });

  it("open reuses an existing tab with a matching url (and focuses it)", async () => {
    const reg = fakeRegistry();
    reg.list = vi.fn(() => [{ id: "browser:a", url: "https://x.com/" }]);
    const sent: any[] = [];
    const win = () => ({ webContents: { send: (_ch: string, name: string, payload: any) => sent.push({ name, payload }) } }) as any;
    srv = new BrowserControlServer(reg as any, win, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "open", url: "https://x.com", secret: "good", workspaceDir: "/ws" });
    expect(resp).toEqual({ ok: true, tabId: "browser:a", reused: true });
    expect(reg.setActive).toHaveBeenCalledWith("browser:a", "/ws");
    expect(sent[0]).toEqual({ name: "browser-focus-request", payload: { tabId: "browser:a", workspaceDir: "/ws" } });
  });

  it("open creates a new tab when no url matches", async () => {
    const reg = fakeRegistry();
    reg.list = vi.fn(() => [{ id: "browser:a", url: "https://other.com/" }]);
    let registered = false;
    reg.has = vi.fn(() => registered);
    const sent: any[] = [];
    const win = () => ({ webContents: { send: (_ch: string, name: string, payload: any) => { sent.push({ name, payload }); registered = true; } } }) as any;
    srv = new BrowserControlServer(reg as any, win, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "open", url: "https://x.com", secret: "good", workspaceDir: "/ws" });
    expect(resp.ok).toBe(true);
    expect(resp.reused).toBe(false);
    expect(resp.tabId).toMatch(/^browser:/);
    expect(sent[0].name).toBe("browser-open-request");
  });

  it("open emits browser-open-request and resolves once registered", async () => {
    const reg = fakeRegistry();
    let registered = false;
    reg.has = vi.fn(() => registered);
    const sent: any[] = [];
    const win = () => ({ webContents: { send: (_ch: string, name: string, payload: any) => {
      sent.push({ name, payload });
      registered = true; // simulate the renderer registering the new tab
    } } }) as any;
    srv = new BrowserControlServer(reg as any, win, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "open", url: "http://x", secret: "good", workspaceDir: "/ws" });
    expect(resp.ok).toBe(true);
    expect(resp.tabId).toMatch(/^browser:/);
    expect(sent[0].name).toBe("browser-open-request");
    expect(sent[0].payload.url).toBe("http://x");
  });
});
