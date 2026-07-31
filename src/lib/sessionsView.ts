import type { Tab, TabUpdatedEvent, WorkingDirectory } from "@/types";

// Spec invariant: every terminal tab IS a session; agentType is presentation,
// not membership. agentsList = sessions filtered to agentType != null.
export interface SessionRow {
  tab: Tab;
  directory: WorkingDirectory;
  agentType: string | null;
}

/** Split sessions into live vs archived, preserving input order in both
 *  buckets. A row is archived iff its tab carries an `archivedAt` stamp. */
export function partitionSessions(
  rows: readonly SessionRow[],
): { live: SessionRow[]; archived: SessionRow[] } {
  const live: SessionRow[] = [];
  const archived: SessionRow[] = [];
  for (const r of rows) {
    if (r.tab.archivedAt != null) archived.push(r);
    else live.push(r);
  }
  return { live, archived };
}

export type ListChangeKind = "archive" | "unarchive" | "enter" | "exit" | null;

export interface ListSnapshotEntry {
  key: string;
  archived: boolean;
}

/** Classify a session-list recompute so the sidebar knows whether it is worth
 *  opening a view transition, and which motion to use. Re-orders return null:
 *  `activityVersion` ticks constantly, and snapshotting on every tick would be
 *  a severe perf regression. Precedence when several apply in one batch:
 *  archive > unarchive > enter > exit. */
export function classifyListChange(
  before: readonly ListSnapshotEntry[],
  after: readonly ListSnapshotEntry[],
): ListChangeKind {
  const beforeMap = new Map(before.map((e) => [e.key, e.archived]));
  const afterMap = new Map(after.map((e) => [e.key, e.archived]));
  let archived = false;
  let unarchived = false;
  let exited = false;
  for (const [key, wasArchived] of beforeMap) {
    const isArchived = afterMap.get(key);
    if (isArchived === undefined) exited = true;
    else if (!wasArchived && isArchived) archived = true;
    else if (wasArchived && !isArchived) unarchived = true;
  }
  let entered = false;
  for (const key of afterMap.keys()) if (!beforeMap.has(key)) entered = true;
  if (archived) return "archive";
  if (unarchived) return "unarchive";
  if (entered) return "enter";
  if (exited) return "exit";
  return null;
}

export function buildSessionsList(
  directories: readonly WorkingDirectory[],
  tabsByDirectory: Record<string, Tab[]>,
  runtime: ReadonlyMap<string, TabUpdatedEvent>,
  onlyDirectoryId: string | null = null,
): SessionRow[] {
  const out: SessionRow[] = [];
  for (const d of directories) {
    if (onlyDirectoryId && d.id !== onlyDirectoryId) continue;
    for (const t of tabsByDirectory[d.id] ?? []) {
      // Runtime authoritative once present (revoked agents must clear).
      const r = runtime.get(t.id);
      const agentType = (r ? r.agentType : t.lastAgentType) ?? null;
      out.push({ tab: t, directory: d, agentType });
    }
  }
  return out;
}
