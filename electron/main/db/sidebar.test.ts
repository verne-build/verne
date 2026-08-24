import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import { getSidebarTabs, saveSidebarTabs, getSidebarState } from "./sidebar";
import type { SidebarTabRow } from "../../../src/types/shared";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-sidebar-"));
  return openDb(join(dir, "verne.db"));
}

const SAMPLE_TABS: SidebarTabRow[] = [
  {
    directoryId: "dir-1",
    tabId: "tab-file",
    tabType: "file",
    label: "index.ts",
    position: 0,
    cursorLine: 10,
    cursorColumn: 5,
  },
  {
    directoryId: "dir-1",
    tabId: "tab-browser",
    tabType: "browser",
    label: "Google",
    position: 1,
    browserUrl: "https://google.com",
    pinned: true,
  },
];

const ALL_TAB_TYPES: SidebarTabRow[] = [
  { directoryId: "dir-1", tabId: "/repo/a.ts", tabType: "file", label: "a.ts", position: 0 },
  { directoryId: "dir-1", tabId: "browser:1", tabType: "browser", label: "New Tab", position: 1, browserUrl: null },
  { directoryId: "dir-1", tabId: "__sc__", tabType: "sourceControl", label: "Source Control", position: 2 },
  { directoryId: "dir-1", tabId: "__commits__", tabType: "commits", label: "History", position: 3 },
  { directoryId: "dir-1", tabId: "__search__", tabType: "search", label: "Search", position: 4 },
  { directoryId: "dir-1", tabId: "__notes__", tabType: "notes", label: "Notes", position: 5 },
  { directoryId: "dir-1", tabId: "explorer:1", tabType: "explorer", label: "Files", position: 6 },
];

describe("sidebar", () => {
  it("getSidebarTabs returns empty array when none", () => {
    const db = tmpDb();
    expect(getSidebarTabs(db, "directory", "dir-1")).toEqual([]);
  });

  it("getSidebarState returns null when none", () => {
    const db = tmpDb();
    expect(getSidebarState(db, "directory", "dir-1")).toBeNull();
  });

  it("saveSidebarTabs + getSidebarTabs round-trip", () => {
    const db = tmpDb();
    saveSidebarTabs(db, "directory", "dir-1", SAMPLE_TABS, "tab-file", 250, null, null);
    const tabs = getSidebarTabs(db, "directory", "dir-1");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].tabId).toBe("tab-file");
    expect(tabs[0].cursorLine).toBe(10);
    expect(tabs[1].pinned).toBe(true);
    expect(tabs[1].browserUrl).toBe("https://google.com");
  });

  it("saveSidebarTabs writes sidebar_state", () => {
    const db = tmpDb();
    saveSidebarTabs(db, "directory", "dir-1", SAMPLE_TABS, "tab-file", 300, "git", "explorer");
    const st = getSidebarState(db, "directory", "dir-1");
    expect(st?.activeTabId).toBe("tab-file");
    expect(st?.listColumnWidth).toBe(300);
    expect(st?.rightSidebarView).toBe("git");
    expect(st?.filePanelActiveId).toBe("explorer");
  });

  it("overwrite clears previous tabs", () => {
    const db = tmpDb();
    saveSidebarTabs(db, "directory", "dir-1", SAMPLE_TABS, "tab-file", 250, null, null);
    saveSidebarTabs(db, "directory", "dir-1", [], "tab-file", 250, null, null);
    expect(getSidebarTabs(db, "directory", "dir-1")).toHaveLength(0);
  });

  it("scoped by scopeType + scopeId", () => {
    const db = tmpDb();
    saveSidebarTabs(db, "directory", "dir-1", SAMPLE_TABS, "tab-file", 250, null, null);
    expect(getSidebarTabs(db, "directory", "dir-2")).toHaveLength(0);
    expect(getSidebarState(db, "directory", "dir-2")).toBeNull();
  });

  it("round-trips every right-panel tab kind", () => {
    const db = tmpDb();
    saveSidebarTabs(db, "directory", "dir-1", ALL_TAB_TYPES, "__notes__", 250, null, "__notes__");
    expect(getSidebarTabs(db, "directory", "dir-1").map((tab) => tab.tabType)).toEqual([
      "file", "browser", "sourceControl", "commits", "search", "notes", "explorer",
    ]);
  });

  it("reads retained metadata from a legacy diff row", () => {
    const db = tmpDb();
    db.prepare(
      `INSERT INTO sidebar_tabs
        (scope_type, directory_id, tab_id, tab_type, label, position,
         diff_source, diff_rel_path, diff_staged, diff_commit_id, diff_commit_short_id, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("directory", "dir-1", "diff:legacy", "diff", "Legacy Diff", 0, "commit", "src/foo.ts", 0, "abc123", "abc", 1);

    expect(getSidebarTabs(db, "directory", "dir-1")).toEqual([expect.objectContaining({
      tabId: "diff:legacy",
      tabType: "diff",
      diffSource: "commit",
      diffRelPath: "src/foo.ts",
      diffStaged: false,
      diffCommitId: "abc123",
      diffCommitShortId: "abc",
      pinned: true,
    })]);
  });
});
