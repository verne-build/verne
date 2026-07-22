import { describe, expect, it } from "vitest";
import { buildSessionsList } from "./sessionsView";
import type { Tab, TabUpdatedEvent, WorkingDirectory } from "@/types";

const dir = (id: string): WorkingDirectory => ({ id, path: `/p/${id}`, name: id }) as WorkingDirectory;
const tab = (id: string, directoryId: string, lastAgentType?: string): Tab =>
  ({ id, directoryId, label: id, cwd: "/p", sortOrder: 0, createdAt: 0, lastAgentType }) as Tab;
const rt = (agentType: string | null): TabUpdatedEvent =>
  ({ tabId: "x", agentType, agentState: "idle" }) as unknown as TabUpdatedEvent;

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
