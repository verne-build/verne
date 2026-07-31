// Pure staleness logic. NO imports — vitest loads this under the `node`
// environment, and anything reaching daemon-supervisor would drag in `electron`.

export type StaleVerdict = "stale" | "silent";

/** Parse `{"src":"..."}` from `verne --version`. Null if unusable. */
export function parseStamp(stdout: string): string | null {
  try {
    const v = JSON.parse(stdout.trim()) as { src?: unknown };
    return typeof v.src === "string" && v.src.length > 0 ? v.src : null;
  } catch {
    return null;
  }
}

/** Matches rpc_daemon.rs's fallback: `unknown daemon method: {other}`. Only a
 *  daemon predating daemon_build_id produces this — i.e. definitionally stale. */
export function isUnknownMethodError(message: string): boolean {
  return message.includes("unknown daemon method");
}

/** Fail-quiet: any uncertainty means no prompt. A false prompt costs the user
 *  every PTY session, so it has to be earned. */
export function daemonVerdict(running: string | null, ondisk: string | null): StaleVerdict {
  if (!running || !ondisk) return "silent";
  if (running === "unknown" || ondisk === "unknown") return "silent";
  return running === ondisk ? "silent" : "stale";
}
