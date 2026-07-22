import type { Tab, TabUpdatedEvent, WorkingDirectory } from "@/types";

// Spec invariant: every terminal tab IS a session; agentType is presentation,
// not membership. agentsList = sessions filtered to agentType != null.
export interface SessionRow {
  tab: Tab;
  directory: WorkingDirectory;
  agentType: string | null;
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
