import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { registerNative } from "../ipc-router";

export function encodeLspFrame(json: string): string {
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

/** Incremental Content-Length frame decoder (stdout may split mid-frame). */
export class LspFrameDecoder {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer, emit: (json: string) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = this.buf.subarray(0, sep).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue; }
      const len = parseInt(m[1], 10);
      const start = sep + 4;
      if (this.buf.length < start + len) return; // wait for full body
      emit(this.buf.subarray(start, start + len).toString("utf8"));
      this.buf = this.buf.subarray(start + len);
    }
  }
}

/** PATH augmented with common node install locations + nvm default.
 *  NOTE: mirrors `expanded_path` in daemon `src/services/git.rs` (kept
 *  independent on purpose — that one is for the daemon's git child). */
export function expandedPath(): string {
  const current = process.env.PATH ?? "";
  const home = homedir();
  const extras = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", join(home, ".volta/bin")];
  try {
    const alias = readFileSync(join(home, ".nvm/alias/default"), "utf8").trim();
    const versions = join(home, ".nvm/versions/node");
    for (const name of readdirSync(versions)) {
      if (name === `v${alias}` || name.startsWith(`v${alias}.`)) { extras.push(join(versions, name, "bin")); break; }
    }
  } catch { /* no nvm */ }
  return [...extras.filter(p => !current.includes(p)), current].join(":");
}

/** Walk up from rootDir to find a project-local tsserver.js (passed to renderer). */
export function findTsserver(rootDir: string): string | null {
  let dir = rootDir;
  for (;;) {
    const c = join(dir, "node_modules/typescript/lib/tsserver.js");
    if (existsSync(c)) return c;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface LspConfig { binary: "node"; entry: string; }
function configFor(language: string, resourceDir: string): LspConfig | null {
  if (language === "typescript") {
    return { binary: "node", entry: join(resourceDir, "bundled/node_modules/typescript-language-server/lib/cli.mjs") };
  }
  return null;
}

interface Instance {
  wss: WebSocketServer;
  child: ChildProcessWithoutNullStreams;
  port: number;
  connected: boolean;
}

const instances = new Map<string, Instance>();
/** Per-key generation: a stop_lsp or newer start_lsp bumps/clears this so an
 *  in-flight start can detect it was superseded before installing its child. */
const startGen = new Map<string, number>();
let genCounter = 0;

const keyOf = (root: string, lang: string) => `${root} ${lang}`;

/** Kill child + close wss, and drop the instance from the map (by identity, so
 *  we never delete a newer instance that replaced this one under the same key). */
function teardown(inst: Instance): void {
  try { inst.child.kill(); } catch { /* already dead */ }
  try { inst.wss.close(); } catch { /* already closed */ }
  for (const [k, v] of [...instances]) if (v === inst) instances.delete(k);
}

function stopInstance(key: string): void {
  const inst = instances.get(key);
  if (inst) teardown(inst);
}

export function stopAllLsp(): void {
  for (const inst of [...instances.values()]) teardown(inst);
}

export function lspInstanceCount(): number {
  return instances.size;
}

export function lspPids(): number[] {
  const out: number[] = [];
  for (const inst of instances.values()) {
    if (typeof inst.child.pid === "number") out.push(inst.child.pid);
  }
  return out;
}

/** Bind an ephemeral ws server, spawn the LSP child, and bridge the first ws
 *  connection to its stdio. Resolves once listening + spawned; rejects (and
 *  cleans up) on bind/spawn error. A watchdog tears everything down if no ws
 *  connects (renderer crashed/reloaded mid-handshake). */
function startBridge(cfg: LspConfig, rootDir: string): Promise<Instance> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let settled = false;

    wss.on("error", (e) => {
      try { wss.close(); } catch { /* noop */ }
      if (!settled) { settled = true; reject(e); }
    });

    wss.on("listening", () => {
      const port = (wss.address() as { port: number }).port;
      const args = ["--max-old-space-size=1024", cfg.entry, "--stdio"];
      const child = spawn(process.execPath, args, {
        cwd: rootDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: expandedPath() },
      }) as ChildProcessWithoutNullStreams;

      const inst: Instance = { wss, child, port, connected: false };

      // Swallow EPIPE etc. on writing to a dead child's stdin (race with exit).
      child.stdin.on("error", () => { /* child gone; ws teardown will follow */ });
      // Log server diagnostics from the moment it starts.
      child.stderr.on("data", (b: Buffer) => console.warn("[lsp]", b.toString().trimEnd()));

      // If spawn fails (bad path / ENOENT) the child emits 'error'. Before a ws
      // connects this rejects the start; after, it just tears down.
      child.on("error", (e) => {
        teardown(inst);
        if (!settled) { settled = true; reject(e); }
      });

      // No ws ever connects → don't leak a tsserver. Renderer retries ~2.5s; 15s is safe.
      const watchdog = setTimeout(() => {
        if (!inst.connected) { console.warn(`[lsp] no ws connection on :${port}; tearing down`); teardown(inst); }
      }, 15000);

      wss.on("connection", (ws: WebSocket) => {
        // The renderer retries the ws up to 5x and keeps the FIRST that opens;
        // wire only the first connection and close any extras so a discarded
        // socket can't end up owning the child's stdio.
        if (inst.connected) { try { ws.close(); } catch { /* noop */ } return; }
        inst.connected = true;
        clearTimeout(watchdog);

        const decoder = new LspFrameDecoder();
        child.stdout.on("data", (chunk: Buffer) =>
          decoder.push(chunk, json => { if (ws.readyState === ws.OPEN) ws.send(json); }));
        ws.on("message", (data) => {
          if (child.stdin.writable) child.stdin.write(encodeLspFrame(data.toString()));
        });
        ws.on("close", () => teardown(inst));
        child.on("exit", () => { try { ws.close(); } catch { /* noop */ } teardown(inst); });
      });

      if (!settled) { settled = true; resolve(inst); }
    });
  });
}

export function registerLspCommands(resourceDir: string): void {
  registerNative("start_lsp", async (p: { rootDir: string; language: string }) => {
    const cfg = configFor(p.language, resourceDir);
    if (!cfg) throw new Error(`No LSP configured for language: ${p.language}`);
    const key = keyOf(p.rootDir, p.language);

    stopInstance(key);             // fresh start, matching old daemon behavior
    const gen = ++genCounter;      // claim this start
    startGen.set(key, gen);

    const inst = await startBridge(cfg, p.rootDir);

    // A stop_lsp or a newer start_lsp during the await invalidated us — don't
    // install an orphan; tear it down instead.
    if (startGen.get(key) !== gen) {
      teardown(inst);
      throw new Error("lsp start superseded");
    }
    instances.set(key, inst);
    return {
      port: inst.port,
      tsserver_path: findTsserver(p.rootDir),
      bundled_node_modules: join(resourceDir, "bundled/node_modules"),
    };
  });

  registerNative("stop_lsp", (p: { rootDir: string; language: string }) => {
    const key = keyOf(p.rootDir, p.language);
    startGen.delete(key);          // invalidate any in-flight start for this key
    stopInstance(key);
    return null;
  });
}
