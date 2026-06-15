import { DatabaseSync } from "node:sqlite";
import type { StoredTabState } from "../../../src/types/shared";

export function getEditorTabs(
  db: DatabaseSync,
  scopeType: string,
  scopeId: string,
): StoredTabState | null {
  const row = db
    .prepare(
      "SELECT tabs, active_tab_id FROM open_tabs WHERE scope_type = ? AND scope_id = ?"
    )
    .get(scopeType, scopeId) as { tabs: string; active_tab_id: string } | undefined;
  if (!row) return null;
  let tabs: StoredTabState["tabs"] = [];
  try {
    tabs = JSON.parse(row.tabs);
  } catch { /* bad JSON → empty */ }
  return { tabs, activeTabId: row.active_tab_id };
}

export function saveEditorTabs(
  db: DatabaseSync,
  scopeType: string,
  scopeId: string,
  state: StoredTabState,
): void {
  const tabsJson = JSON.stringify(state.tabs);
  db.prepare(
    "INSERT OR REPLACE INTO open_tabs (scope_type, scope_id, tabs, active_tab_id) VALUES (?, ?, ?, ?)"
  ).run(scopeType, scopeId, tabsJson, state.activeTabId);
}
