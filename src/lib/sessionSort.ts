import type { SessionRow } from "@/lib/sessionsView";

// Spec §Sorting: root name → roots-before-worktrees (then worktree name) →
// agents-before-terminals → recency desc. Pure + stable; recency comes from a
// snapshot map (discrete events only), never live status ticks.
export interface CardSortInputs {
  rootNameOf: (dirId: string) => string;
  worktreeNameOf: (dirId: string) => string | null;
  activityAt: (tabId: string) => number;
}

export function sortSessionCards(rows: readonly SessionRow[], inputs: CardSortInputs): SessionRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const rootA = inputs.rootNameOf(a.r.directory.id).toLowerCase();
      const rootB = inputs.rootNameOf(b.r.directory.id).toLowerCase();
      if (rootA !== rootB) return rootA < rootB ? -1 : 1;
      const wtA = inputs.worktreeNameOf(a.r.directory.id);
      const wtB = inputs.worktreeNameOf(b.r.directory.id);
      if ((wtA === null) !== (wtB === null)) return wtA === null ? -1 : 1; // root sessions first
      if (wtA !== null && wtB !== null && wtA !== wtB) return wtA < wtB ? -1 : 1;
      const agentA = a.r.agentType ? 0 : 1;
      const agentB = b.r.agentType ? 0 : 1;
      if (agentA !== agentB) return agentA - agentB;
      const actA = inputs.activityAt(a.r.tab.id);
      const actB = inputs.activityAt(b.r.tab.id);
      if (actA !== actB) return actB - actA;
      return a.i - b.i; // stable
    })
    .map((x) => x.r);
}

export function relativeTime(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}
