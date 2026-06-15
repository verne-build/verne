import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { openSync, existsSync, mkdirSync } from "node:fs";
import { app } from "electron";
import { join } from "node:path";
import { DaemonClient } from "./daemon-client";
import { socketPath, sidecarSocketPath, internalDataDir, daemonLog, sidecarLog, wsPort } from "./paths";

// Bundled daemon binary path: resources/verne in production. In dev the in-repo
// crate builds to daemon/target/debug/verne (app.getAppPath() is the repo root).
// VERNE_DAEMON_BIN remains an optional override.
function daemonBinary(): string {
  if (app.isPackaged) return join(process.resourcesPath, "verne");
  return process.env.VERNE_DAEMON_BIN ?? join(app.getAppPath(), "daemon", "target", "debug", "verne");
}

// Sidecar binary path — mirrors daemonBinary() but for `verne-sidecar`. The
// workspace puts both bins under daemon/target/debug in dev.
function sidecarBinary(): string {
  if (app.isPackaged) return join(process.resourcesPath, "verne-sidecar");
  return process.env.VERNE_SIDECAR_BIN ?? join(app.getAppPath(), "daemon", "target", "debug", "verne-sidecar");
}

// Dir containing bundled assets (`bundled/`, notification sounds). In production
// these are under resourcesPath; in dev they live in the in-repo `resources/`
// dir. Derived from THIS app's build identity — not VERNE_RESOURCE_DIR, which
// the daemon injects into PTYs (so a nested `pnpm dev` would otherwise pull
// prod's bundled binaries from /Applications/Verne.app). See paths.ts.
function resourceDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  return join(app.getAppPath(), "resources");
}

async function tryConnect(retries = 30, delayMs = 100): Promise<DaemonClient> {
  for (let i = 0; i < retries; i++) {
    if (existsSync(socketPath)) {
      try { const c = new DaemonClient(socketPath); await c.connect(); return c; }
      catch { /* socket exists but not yet accepting; retry */ }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`daemon socket never came up at ${socketPath}`);
}

// PIDs currently LISTENing on our WS port (macOS lsof). Empty if free.
function wsPortHolders(): number[] {
  try {
    return execFileSync("lsof", ["-ti", `tcp:${wsPort}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // lsof exits non-zero when nothing is listening → port is free
  }
}

/**
 * Free our WS port before spawning a fresh daemon.
 *
 * Orphaned daemons from older builds (or crashed/replaced instances) can keep
 * holding the TCP WS port after losing their Unix-socket identity. A new daemon
 * then can't bind it (now fatal — it exits), so the supervisor would never come
 * up. Only called on the spawn path: if we're reusing a live daemon we never
 * touch the port it owns. Dev uses 9601 / prod 9600, so this never disturbs a
 * separately-running prod app.
 */
async function freeWsPort(): Promise<void> {
  const holders = wsPortHolders();
  if (holders.length === 0) return;
  for (const pid of holders) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (let i = 0; i < 20 && wsPortHolders().length > 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnDaemon(): void {
  mkdirSync(internalDataDir, { recursive: true });
  const log = openSync(daemonLog, "a");
  const child = spawn(daemonBinary(), ["--server"], {
    detached: true,
    stdio: ["ignore", "ignore", log],
    env: {
      ...process.env,
      VERNE_INTERNAL_DATA_DIR: internalDataDir,
      VERNE_RESOURCE_DIR: resourceDir(),
      VERNE_WS_PORT: String(wsPort),
    },
  });
  child.unref(); // detached: daemon outlives this Electron process / reloads
}

/** Connect to a running daemon, or spawn one and connect. Idempotent across reloads:
 *  a pre-existing detached daemon is reused, preserving PTY sessions. */
export async function ensureDaemon(): Promise<DaemonClient> {
  if (existsSync(socketPath)) {
    try { const c = new DaemonClient(socketPath); await c.connect(); return c; } catch { /* stale; respawn */ }
  }
  // No reusable daemon → spawning a fresh one. Reap any orphan still holding the
  // WS port so the new daemon's (now fatal) bind succeeds.
  await freeWsPort();
  spawnDaemon();
  return tryConnect();
}

/** Restart the detached daemon IN PLACE, reusing the same client instance so all
 *  captured references (router, detection, tab orchestration, metrics) stay valid
 *  and registered event handlers keep firing. All PTY sessions die with the old
 *  daemon — this is a hard restart, not a reconnect. */
export async function restartDaemon(client: DaemonClient): Promise<void> {
  client.close(); // __shutdown + end sockets → old daemon exits and removes its socket
  // Wait for the old daemon to drop its socket so we don't reconnect to the dying one.
  for (let i = 0; i < 50 && existsSync(socketPath); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await freeWsPort();
  spawnDaemon();
  // Reconnect the SAME instance (not a fresh one) so existing references stay valid.
  let connected = false;
  for (let i = 0; i < 30 && !connected; i++) {
    if (existsSync(socketPath)) {
      try { await client.connect(); connected = true; break; } catch { /* not accepting yet */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!connected) throw new Error(`daemon socket never came up at ${socketPath}`);
  await client.subscribeEvents(); // re-attach the event stream; handlers persist on the instance
}

// The sidecar is tied to THIS app's lifecycle (NOT detached) so it dies with the
// app. Kept so before-quit can stop it cleanly.
let sidecarChild: ChildProcess | null = null;

function spawnSidecar(): void {
  mkdirSync(internalDataDir, { recursive: true });
  const log = openSync(sidecarLog, "a");
  sidecarChild = spawn(sidecarBinary(), ["--server"], {
    // NOT detached: the sidecar is restartable and must not outlive the app.
    stdio: ["ignore", "ignore", log],
    env: {
      ...process.env,
      VERNE_INTERNAL_DATA_DIR: internalDataDir,
      VERNE_RESOURCE_DIR: resourceDir(),
      VERNE_WS_PORT: String(wsPort),
    },
  });
  sidecarChild.on("exit", () => { sidecarChild = null; });
}

async function tryConnectSidecar(retries = 50, delayMs = 100): Promise<DaemonClient> {
  for (let i = 0; i < retries; i++) {
    if (existsSync(sidecarSocketPath)) {
      try { const c = new DaemonClient(sidecarSocketPath); await c.connect(); return c; }
      catch { /* socket exists but not yet accepting; retry */ }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`sidecar socket never came up at ${sidecarSocketPath}`);
}

/** Connect to the sidecar, spawning it if needed. Unlike the daemon, the sidecar
 *  is restartable; a reachable one is reused, otherwise a fresh one is spawned. */
export async function ensureSidecar(): Promise<DaemonClient> {
  if (existsSync(sidecarSocketPath)) {
    try { const c = new DaemonClient(sidecarSocketPath); await c.connect(); return c; } catch { /* stale; respawn */ }
  }
  spawnSidecar();
  return tryConnectSidecar();
}

/** Stop the sidecar process spawned by this app (best-effort). */
export function killSidecar(): void {
  try { sidecarChild?.kill("SIGTERM"); } catch { /* already gone */ }
  sidecarChild = null;
}
