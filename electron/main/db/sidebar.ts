import { DatabaseSync } from "node:sqlite";
import type { SidebarTabRow, SidebarState } from "../../../src/types/shared";

type SidebarTabDbRow = {
  directory_id: string;
  tab_id: string;
  tab_type: string;
  label: string;
  position: number;
  cursor_line: number | null;
  cursor_column: number | null;
  scroll_top: number | null;
  diff_source: string | null;
  diff_rel_path: string | null;
  diff_staged: number | null;
  diff_commit_id: string | null;
  diff_commit_short_id: string | null;
  browser_url: string | null;
  pinned: number | null;
};

function rowToSidebarTab(row: SidebarTabDbRow): SidebarTabRow {
  return {
    directoryId: row.directory_id,
    tabId: row.tab_id,
    tabType: row.tab_type as SidebarTabRow["tabType"],
    label: row.label,
    position: row.position,
    cursorLine: row.cursor_line ?? undefined,
    cursorColumn: row.cursor_column ?? undefined,
    scrollTop: row.scroll_top ?? undefined,
    diffSource: (row.diff_source as SidebarTabRow["diffSource"]) ?? undefined,
    diffRelPath: row.diff_rel_path ?? undefined,
    diffStaged: row.diff_staged != null ? row.diff_staged !== 0 : undefined,
    diffCommitId: row.diff_commit_id ?? undefined,
    diffCommitShortId: row.diff_commit_short_id ?? undefined,
    browserUrl: row.browser_url ?? undefined,
    pinned: row.pinned != null ? row.pinned !== 0 : false,
  };
}

export function getSidebarTabs(
  db: DatabaseSync,
  scopeType: string,
  scopeId: string,
): SidebarTabRow[] {
  const rows = db
    .prepare(
      `SELECT directory_id, tab_id, tab_type, label, position,
              cursor_line, cursor_column, scroll_top,
              diff_source, diff_rel_path, diff_staged, diff_commit_id, diff_commit_short_id,
              browser_url, pinned
       FROM sidebar_tabs
       WHERE scope_type = ? AND directory_id = ?
       ORDER BY position`
    )
    .all(scopeType, scopeId) as SidebarTabDbRow[];
  return rows.map(rowToSidebarTab);
}

export function saveSidebarTabs(
  db: DatabaseSync,
  scopeType: string,
  scopeId: string,
  tabs: SidebarTabRow[],
  activeTabId: string,
  listColumnWidth: number,
  rightSidebarView: string | null,
  filePanelActiveId: string | null,
): void {
  db.prepare(
    "DELETE FROM sidebar_tabs WHERE scope_type = ? AND directory_id = ?"
  ).run(scopeType, scopeId);

  const insertTab = db.prepare(
    `INSERT INTO sidebar_tabs
      (scope_type, directory_id, tab_id, tab_type, label, position,
       cursor_line, cursor_column, scroll_top,
       diff_source, diff_rel_path, diff_staged, diff_commit_id, diff_commit_short_id,
       browser_url, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const tab of tabs) {
    insertTab.run(
      scopeType,
      scopeId,
      tab.tabId,
      tab.tabType,
      tab.label,
      tab.position,
      tab.cursorLine ?? null,
      tab.cursorColumn ?? null,
      tab.scrollTop ?? null,
      tab.diffSource ?? null,
      tab.diffRelPath ?? null,
      tab.diffStaged != null ? (tab.diffStaged ? 1 : 0) : null,
      tab.diffCommitId ?? null,
      tab.diffCommitShortId ?? null,
      tab.browserUrl ?? null,
      tab.pinned ? 1 : 0,
    );
  }

  db.prepare(
    `INSERT OR REPLACE INTO sidebar_state
      (scope_type, directory_id, active_tab_id, list_column_width, right_sidebar_view, file_panel_active_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(scopeType, scopeId, activeTabId, listColumnWidth, rightSidebarView, filePanelActiveId);
}

export function getSidebarState(
  db: DatabaseSync,
  scopeType: string,
  scopeId: string,
): SidebarState | null {
  const row = db
    .prepare(
      `SELECT directory_id, active_tab_id, list_column_width, right_sidebar_view, file_panel_active_id
       FROM sidebar_state
       WHERE scope_type = ? AND directory_id = ?`
    )
    .get(scopeType, scopeId) as {
      directory_id: string;
      active_tab_id: string;
      list_column_width: number | null;
      right_sidebar_view: string | null;
      file_panel_active_id: string | null;
    } | undefined;
  if (!row) return null;
  return {
    directoryId: row.directory_id,
    activeTabId: row.active_tab_id,
    listColumnWidth: row.list_column_width ?? 250,
    rightSidebarView: row.right_sidebar_view ?? undefined,
    filePanelActiveId: row.file_panel_active_id ?? undefined,
  };
}
