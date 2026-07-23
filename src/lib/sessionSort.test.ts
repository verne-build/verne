import { describe, expect, it } from "vitest";
import { relativeTime, sortSessionCards, type CardSortInputs } from "./sessionSort";
import type { SessionRow } from "@/lib/sessionsView";
import type { Tab, WorkingDirectory } from "@/types";

const dir = (id: string, name: string, parentDirectoryId?: string): WorkingDirectory =>
  ({ id, path: `/p/${id}`, name, parentDirectoryId }) as WorkingDirectory;
const row = (id: string, d: WorkingDirectory, agentType: string | null): SessionRow =>
  ({ tab: { id, directoryId: d.id } as Tab, directory: d, agentType });

const beta = dir("d-beta", "beta");
const alpha = dir("d-alpha", "Alpha");
const alphaWt = dir("d-wt", "perf", "d-alpha");

const inputs = (activity: Record<string, number>): CardSortInputs => ({
  rootNameOf: (dirId) => (dirId === "d-wt" || dirId === "d-alpha" ? "Alpha" : "beta"),
  worktreeNameOf: (dirId) => (dirId === "d-wt" ? "perf" : null),
  activityAt: (tabId) => activity[tabId] ?? 0,
});

describe("sortSessionCards", () => {
  it("groups by root name (case-insensitive), roots before worktrees, agents before terminals, recency desc", () => {
    const rows = [
      row("t-beta-term", beta, null),
      row("t-wt-agent", alphaWt, "claude"),
      row("t-alpha-term", alpha, null),
      row("t-alpha-agent-old", alpha, "codex"),
      row("t-alpha-agent-new", alpha, "claude"),
    ];
    const out = sortSessionCards(rows, inputs({ "t-alpha-agent-new": 200, "t-alpha-agent-old": 100 }));
    expect(out.map((r) => r.tab.id)).toEqual([
      "t-alpha-agent-new", // Alpha root, agent, most recent
      "t-alpha-agent-old", // Alpha root, agent, older
      "t-alpha-term",      // Alpha root, terminal
      "t-wt-agent",        // Alpha worktree "perf" after root sessions
      "t-beta-term",       // beta root
    ]);
  });

  it("is non-mutating and stable for equal keys", () => {
    const a = row("t1", alpha, null);
    const b = row("t2", alpha, null);
    const rows = [a, b];
    const out = sortSessionCards(rows, inputs({}));
    expect(rows).toEqual([a, b]); // input untouched
    expect(out.map((r) => r.tab.id)).toEqual(["t1", "t2"]); // stable
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("boundaries", () => {
    expect(relativeTime(now - 59_000, now)).toBe("now");
    expect(relativeTime(now - 60_000, now)).toBe("1m");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m");
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h");
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe("1d");
    expect(relativeTime(now - 7 * 86_400_000, now)).toBe("1w");
  });
  it("future/zero clamps to now", () => {
    expect(relativeTime(now + 5_000, now)).toBe("now");
  });
});
