import { describe, expect, it } from "vitest";
import { buildSessionsList, classifyListChange, partitionSessions, type SessionRow } from "./sessionsView";
import type { Tab, TabUpdatedEvent, WorkingDirectory } from "@/types";

const dir = (id: string): WorkingDirectory => ({ id, path: `/p/${id}`, name: id }) as WorkingDirectory;
const tab = (id: string, directoryId: string, lastAgentType?: string): Tab =>
  ({ id, directoryId, label: id, cwd: "/p", sortOrder: 0, createdAt: 0, lastAgentType }) as Tab;
const rt = (agentType: string | null): TabUpdatedEvent =>
  ({ tabId: "x", agentType, agentState: "idle" }) as unknown as TabUpdatedEvent;
const row = (id: string, archivedAt?: number): SessionRow => ({
  tab: { ...tab(id, "d1"), archivedAt },
  directory: dir("d1"),
  agentType: null,
});

describe("buildSessionsList", () => {
  const dirs = [dir("d1"), dir("d2")];
  const tabs = { d1: [tab("t1", "d1", "claude"), tab("t2", "d1")], d2: [tab("t3", "d2")] };

  it("includes EVERY tab as a session, agent or not", () => {
    const rows = buildSessionsList(dirs, tabs, new Map());
    expect(rows.map((r) => r.tab.id)).toEqual(["t1", "t2", "t3"]);
    expect(rows[0].agentType).toBe("claude");
    expect(rows[1].agentType).toBeNull();
  });

  it("runtime is authoritative over lastAgentType once present", () => {
    const runtime = new Map([["t1", rt(null)]]); // agent revoked live
    const rows = buildSessionsList(dirs, tabs, runtime);
    expect(rows.find((r) => r.tab.id === "t1")!.agentType).toBeNull();
  });

  it("filters by directory when onlyDirectoryId given", () => {
    const rows = buildSessionsList(dirs, tabs, new Map(), "d2");
    expect(rows.map((r) => r.tab.id)).toEqual(["t3"]);
  });
});

describe("partitionSessions", () => {
  it("puts only archivedAt rows into archived, preserving input order in both buckets", () => {
    const rows = [row("t1"), row("t2", 100), row("t3"), row("t4", 200)];
    const { live, archived } = partitionSessions(rows);
    expect(live.map((r) => r.tab.id)).toEqual(["t1", "t3"]);
    expect(archived.map((r) => r.tab.id)).toEqual(["t2", "t4"]);
  });

  it("all-live and all-archived inputs partition cleanly", () => {
    expect(partitionSessions([row("t1"), row("t2")]).archived).toEqual([]);
    expect(partitionSessions([row("t1", 1), row("t2", 2)]).live).toEqual([]);
  });

  it("empty input yields empty buckets", () => {
    expect(partitionSessions([])).toEqual({ live: [], archived: [] });
  });
});

describe("classifyListChange", () => {
  const live = (key: string) => ({ key, archived: false });
  const gone = (key: string) => ({ key, archived: true });

  it("returns null when nothing changed", () => {
    expect(classifyListChange([live("a"), live("b")], [live("a"), live("b")])).toBeNull();
  });

  it("returns null for a re-order only", () => {
    expect(classifyListChange([live("a"), live("b")], [live("b"), live("a")])).toBeNull();
  });

  it("returns archive when a key flips to archived", () => {
    expect(classifyListChange([live("a"), live("b")], [live("b"), gone("a")])).toBe("archive");
  });

  it("returns unarchive when a key flips back to live", () => {
    expect(classifyListChange([gone("a"), live("b")], [live("a"), live("b")])).toBe("unarchive");
  });

  it("returns enter when a key is added", () => {
    expect(classifyListChange([live("a")], [live("a"), live("b")])).toBe("enter");
  });

  it("returns exit when a key is removed", () => {
    expect(classifyListChange([live("a"), live("b")], [live("a")])).toBe("exit");
  });

  it("prefers archive over unarchive, enter and exit in a mixed batch", () => {
    const before = [live("a"), gone("b"), live("c")];
    const after = [gone("a"), live("b"), live("d")];
    expect(classifyListChange(before, after)).toBe("archive");
  });

  it("prefers enter over exit when both happen", () => {
    expect(classifyListChange([live("a")], [live("b")])).toBe("enter");
  });

  it("treats empty→empty as null", () => {
    expect(classifyListChange([], [])).toBeNull();
  });
});
