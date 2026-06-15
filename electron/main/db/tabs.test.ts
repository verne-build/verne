import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import { insertDirectory } from "./directories";
import {
  insertTab,
  getTab,
  getTabs,
  renameTab,
  reorderTabs,
  deleteTab,
  recordTabSession,
  clearStaleTabStates,
  updateTabPresentationSnapshot,
  tabDisplayLabels,
  defaultLabel,
} from "./tabs";
import type { Tab } from "../../../src/types/shared";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-tabs-"));
  const db = openDb(join(dir, "verne.db"));
  insertDirectory(db, { id: "d1", path: "/tmp/d1", name: "dir-one", createdAt: 0, sortOrder: 0 });
  insertDirectory(db, { id: "d2", path: "/tmp/d2", name: "dir-two", createdAt: 0, sortOrder: 1 });
  return db;
}

function mkTab(over: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    directoryId: "d1",
    label: "1",
    cwd: "/tmp/d1",
    sortOrder: 0,
    createdAt: 100,
    userRenamed: false,
    ...over,
  };
}

describe("tabs", () => {
  it("insertTab + getTab round-trips camelCase shape", () => {
    const db = tmpDb();
    insertTab(db, mkTab({ lastAgentType: "claude", lastAgentSessionId: "s1", lastAgentState: "idle" }));
    const got = getTab(db, "t1");
    expect(got).toEqual({
      id: "t1",
      directoryId: "d1",
      label: "1",
      cwd: "/tmp/d1",
      sortOrder: 0,
      createdAt: 100,
      lastAgentType: "claude",
      lastAgentSessionId: "s1",
      lastAgentState: "idle",
      userRenamed: false,
    });
  });

  it("getTab returns undefined for unknown id", () => {
    const db = tmpDb();
    expect(getTab(db, "nope")).toBeUndefined();
  });

  it("null last_agent_* columns omitted (undefined)", () => {
    const db = tmpDb();
    insertTab(db, mkTab());
    const got = getTab(db, "t1")!;
    expect(got.lastAgentType).toBeUndefined();
    expect(got.lastAgentSessionId).toBeUndefined();
    expect(got.lastAgentState).toBeUndefined();
    expect("lastAgentType" in got).toBe(false);
  });

  it("getTabs filtered orders by sort_order, created_at", () => {
    const db = tmpDb();
    insertTab(db, mkTab({ id: "a", sortOrder: 1, createdAt: 1 }));
    insertTab(db, mkTab({ id: "b", sortOrder: 0, createdAt: 2 }));
    insertTab(db, mkTab({ id: "c", directoryId: "d2", sortOrder: 0, createdAt: 0 }));
    const tabs = getTabs(db, "d1");
    expect(tabs.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("getTabs unfiltered orders by directory_id, sort_order, created_at", () => {
    const db = tmpDb();
    insertTab(db, mkTab({ id: "a", directoryId: "d2", sortOrder: 0 }));
    insertTab(db, mkTab({ id: "b", directoryId: "d1", sortOrder: 0 }));
    expect(getTabs(db).map((t) => t.id)).toEqual(["b", "a"]);
    expect(getTabs(db, null).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("renameTab sets label + userRenamed", () => {
    const db = tmpDb();
    insertTab(db, mkTab());
    renameTab(db, "t1", "renamed");
    const got = getTab(db, "t1")!;
    expect(got.label).toBe("renamed");
    expect(got.userRenamed).toBe(true);
  });

  it("reorderTabs sets sort_order to index", () => {
    const db = tmpDb();
    insertTab(db, mkTab({ id: "a", sortOrder: 5 }));
    insertTab(db, mkTab({ id: "b", sortOrder: 5 }));
    reorderTabs(db, ["b", "a"]);
    expect(getTab(db, "b")!.sortOrder).toBe(0);
    expect(getTab(db, "a")!.sortOrder).toBe(1);
  });

  it("clearStaleTabStates empty clears all", () => {
    const db = tmpDb();
    insertTab(db, mkTab({ id: "a", lastAgentType: "claude", lastAgentState: "idle", lastAgentSessionId: "s" }));
    insertTab(db, mkTab({ id: "b", lastAgentType: "codex", lastAgentState: "working", lastAgentSessionId: "s2" }));
    clearStaleTabStates(db, []);
    for (const id of ["a", "b"]) {
      const t = getTab(db, id)!;
      expect(t.lastAgentType).toBeUndefined();
      expect(t.lastAgentState).toBeUndefined();
      expect(t.lastAgentSessionId).toBeUndefined();
    }
  });

  it("clearStaleTabStates non-empty clears only NOT IN live", () => {
    const db = tmpDb();
    insertTab(db, mkTab({ id: "live", lastAgentType: "claude", lastAgentState: "idle" }));
    insertTab(db, mkTab({ id: "dead", lastAgentType: "codex", lastAgentState: "working" }));
    clearStaleTabStates(db, ["live"]);
    expect(getTab(db, "live")!.lastAgentType).toBe("claude");
    expect(getTab(db, "dead")!.lastAgentType).toBeUndefined();
  });

  it("updates the last-known presentation snapshot", () => {
    const db = tmpDb();
    insertTab(db, mkTab());
    updateTabPresentationSnapshot(db, {
      tabId: "t1",
      agentType: "codex",
      agentState: "blocked",
      sessionId: "s2",
    });
    expect(getTab(db, "t1")).toMatchObject({
      lastAgentType: "codex",
      lastAgentState: "blocked",
      lastAgentSessionId: "s2",
    });
  });

  it("recordTabSession inserts then ON CONFLICT updates last_seen_at", () => {
    const db = tmpDb();
    insertTab(db, mkTab());
    recordTabSession(db, "sess1", "t1", "/tmp/d1", "claude", 1000);
    let row = db.prepare("SELECT * FROM tab_sessions WHERE session_id = ?").get("sess1") as {
      created_at: number;
      last_seen_at: number;
      tab_id: string;
    };
    expect(row.created_at).toBe(1000);
    expect(row.last_seen_at).toBe(1000);
    expect(row.tab_id).toBe("t1");
    recordTabSession(db, "sess1", "t1", "/tmp/d1", "claude", 2000);
    row = db.prepare("SELECT * FROM tab_sessions WHERE session_id = ?").get("sess1") as typeof row;
    expect(row.created_at).toBe(1000);
    expect(row.last_seen_at).toBe(2000);
  });

  it("deleteTab removes row + cascades tab_sessions", () => {
    const db = tmpDb();
    insertTab(db, mkTab());
    recordTabSession(db, "sess1", "t1", "/tmp/d1", "claude", 1000);
    deleteTab(db, "t1");
    expect(getTab(db, "t1")).toBeUndefined();
    expect(db.prepare("SELECT * FROM tab_sessions WHERE session_id = ?").get("sess1")).toBeUndefined();
  });

  it("tabDisplayLabels returns directory name + tab label", () => {
    const db = tmpDb();
    insertTab(db, mkTab({ label: "my-tab" }));
    expect(tabDisplayLabels(db, "t1")).toEqual({ directoryName: "dir-one", tabLabel: "my-tab" });
    expect(tabDisplayLabels(db, "nope")).toEqual({});
  });

  it("defaultLabel is count+1", () => {
    expect(defaultLabel(0)).toBe("1");
    expect(defaultLabel(3)).toBe("4");
  });
});
