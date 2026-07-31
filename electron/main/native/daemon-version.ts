import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DaemonClient } from "../daemon-client";
import { daemonBinary } from "../daemon-supervisor";
import { daemonVerdict, isUnknownMethodError, parseStamp, type StaleVerdict } from "./daemon-staleness";

const execFileP = promisify(execFile);

// Short — a wedged binary must never delay launch.
const VERSION_TIMEOUT_MS = 3000;

/** Stamp of the binary on disk. Always the absolute path from daemonBinary() —
 *  never PATH or the ~/.local/bin symlink, which can point at another install. */
async function readOnDiskStamp(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(daemonBinary(), ["--version"], { timeout: VERSION_TIMEOUT_MS });
    return parseStamp(stdout);
  } catch {
    return null;
  }
}

/**
 * Compare the running daemon's build stamp against the binary on disk.
 *
 * Resolves "silent" on every failure path — the one exception is an
 * unknown-method error, which only a daemon predating this feature can produce
 * and therefore means stale.
 */
export async function checkDaemonStale(daemon: DaemonClient): Promise<StaleVerdict> {
  const ondisk = await readOnDiskStamp();

  let running: string | null;
  try {
    const r = await daemon.request<{ src?: unknown }>("daemon_build_id", null);
    running = typeof r?.src === "string" && r.src.length > 0 ? r.src : null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return isUnknownMethodError(message) ? "stale" : "silent";
  }

  return daemonVerdict(running, ondisk);
}
