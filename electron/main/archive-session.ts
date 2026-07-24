import type { ArchivedSnapshotBlob, GridSnapshotDump, Tab } from "../../src/types/shared";
import { resumeCommand } from "./resume-registry";

// Dependency-injected so the ordering/failure semantics below are testable
// without a real daemon socket or SQLite file (see archive-session.test.ts).
export interface ArchiveSessionDeps {
  getTab: (id: string) => Tab | null | undefined;
  daemonRequest: <T>(method: string, params: unknown) => Promise<T>;
  writeSnapshot: (id: string, dump: GridSnapshotDump, capturedAt: number) => Promise<void>;
  readSnapshot: (id: string) => ArchivedSnapshotBlob | null;
  setArchivedAt: (id: string, archivedAt: number | null) => void;
  deleteSnapshot: (id: string) => void;
  /** Run a raw transaction control statement — BEGIN | COMMIT | ROLLBACK. */
  dbExec: (sql: "BEGIN" | "COMMIT" | "ROLLBACK") => void;
  /** Build the daemon tab_spawn plan from the persisted row (shared with
   *  tabs_create/tabs_session_id so the shape can't drift). */
  buildPlan: (tab: Tab, startupCommand?: string) => unknown;
  now: () => number;
}

export interface ArchiveSessionOperations {
  archive(id: string): Promise<Tab>;
  unarchive(id: string, resume: boolean): Promise<Tab>;
  read(id: string): ArchivedSnapshotBlob | null;
}

/** Orchestrates the archive flow across the daemon (live PTY) + db (persisted
 *  row + snapshot blob). Strict ordering, enforced here rather than left to
 *  caller discipline:
 *
 *  1. daemon `tab_snapshot` — capture the grid dump while the PTY is still live.
 *  2. db `write_snapshot`   — durable BEFORE kill (SQLite autocommit).
 *  3. daemon `tab_kill`     — stop the PTY.
 *  4. db `set_archived_at`  — final visibility switch; only flipped once the
 *     PTY is confirmed dead, so a kill failure never orphans a live session
 *     as "archived". The written blob is kept either way (retained for retry).
 */
export function createArchiveSessionOperations(deps: ArchiveSessionDeps): ArchiveSessionOperations {
  async function archive(id: string): Promise<Tab> {
    const tab = deps.getTab(id);
    if (!tab) throw new Error("tab not found");
    if (tab.archivedAt != null) return tab;

    const dump = await deps.daemonRequest<GridSnapshotDump>("tab_snapshot", { tabId: id });
    const capturedAt = deps.now();
    await deps.writeSnapshot(id, dump, capturedAt); // durable before kill
    let killed: boolean;
    try {
      killed = await deps.daemonRequest<boolean>("tab_kill", { tabId: id });
    } catch {
      killed = false;
    }
    if (!killed) throw new Error("failed to stop session; snapshot retained for retry");
    deps.setArchivedAt(id, capturedAt);
    const updated = deps.getTab(id);
    if (!updated) throw new Error("tab gone after archive");
    return updated;
  }

  /** Bring an archived session back to life. Strict ordering + failure
   *  semantics, enforced here rather than left to caller discipline:
   *
   *  1. Spawn the live PTY FIRST (with the resume startupCommand when asked).
   *     A spawn failure leaves `archived_at` + the snapshot blob untouched, so
   *     the tab is still cleanly archived and recoverable.
   *  2. THEN finalize the DB in one transaction: clear `archived_at` + delete
   *     the snapshot blob. Only after BOTH succeed is the tab "live".
   *  3. On DB-finalize failure: ROLLBACK, then kill the just-spawned PTY to
   *     restore the archived-only state. If that kill ALSO fails we may be in a
   *     dual-source state (live PTY + archived row) — surface an AggregateError
   *     rather than hide it. Otherwise rethrow the original DB error. */
  async function unarchive(id: string, resume: boolean): Promise<Tab> {
    const tab = deps.getTab(id);
    if (!tab) throw new Error("tab not found");
    if (tab.archivedAt == null) throw new Error("session is not archived");

    // Renderer only offers resume when resumeAvailable; if resume was requested
    // but is unsupported (unknown agent / missing id), spawn a fresh shell.
    const command = resume ? resumeCommand(tab.lastAgentType, tab.lastAgentSessionId) : undefined;
    await deps.daemonRequest("tab_spawn", { plan: deps.buildPlan(tab, command) });

    try {
      deps.dbExec("BEGIN");
      deps.setArchivedAt(id, null);
      deps.deleteSnapshot(id);
      deps.dbExec("COMMIT");
    } catch (error) {
      deps.dbExec("ROLLBACK");
      try {
        const killed = await deps.daemonRequest<boolean>("tab_kill", { tabId: id });
        if (!killed) throw new Error("spawn rollback did not find the live session");
      } catch (killError) {
        throw new AggregateError([error, killError], "failed to restore archived-only state");
      }
      throw error;
    }

    const updated = deps.getTab(id);
    if (!updated) throw new Error("tab gone after unarchive");
    return updated;
  }

  function read(id: string): ArchivedSnapshotBlob | null {
    return deps.readSnapshot(id);
  }

  return { archive, unarchive, read };
}

/** Guard for the legacy `tabs_session_id` live-session seam: an archived row
 *  must never respawn through it — that would create a second source of
 *  truth (a live PTY under a tab the DB still marks archived). Only the
 *  explicit `tabs_unarchive` flow may bring an archived tab back to life. */
export function assertRespawnable(tab: Tab): void {
  if (tab.archivedAt != null) throw new Error("archived session cannot spawn");
}
