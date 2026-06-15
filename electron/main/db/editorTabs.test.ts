import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import { getEditorTabs, saveEditorTabs } from "./editorTabs";
import type { StoredTabState } from "../../../src/types/shared";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-editortabs-"));
  return openDb(join(dir, "verne.db"));
}

const SAMPLE: StoredTabState = {
  tabs: [
    { id: "t1", type: "file", label: "index.ts", pinned: false, filePath: "/src/index.ts" },
  ],
  activeTabId: "t1",
};

describe("editorTabs", () => {
  it("returns null when no row exists", () => {
    const db = tmpDb();
    expect(getEditorTabs(db, "directory", "dir-1")).toBeNull();
  });

  it("save + get round-trip", () => {
    const db = tmpDb();
    saveEditorTabs(db, "directory", "dir-1", SAMPLE);
    const got = getEditorTabs(db, "directory", "dir-1");
    expect(got?.activeTabId).toBe("t1");
    expect(got?.tabs).toHaveLength(1);
    expect(got?.tabs[0].id).toBe("t1");
  });

  it("overwrites on second save", () => {
    const db = tmpDb();
    saveEditorTabs(db, "directory", "dir-1", SAMPLE);
    saveEditorTabs(db, "directory", "dir-1", { tabs: [], activeTabId: "" });
    const got = getEditorTabs(db, "directory", "dir-1");
    expect(got?.tabs).toHaveLength(0);
  });

  it("scopes by scopeType + scopeId", () => {
    const db = tmpDb();
    saveEditorTabs(db, "directory", "dir-1", SAMPLE);
    expect(getEditorTabs(db, "directory", "dir-2")).toBeNull();
    expect(getEditorTabs(db, "agent_worktree", "dir-1")).toBeNull();
  });
});
