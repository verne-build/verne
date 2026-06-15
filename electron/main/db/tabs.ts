import { DatabaseSync } from "node:sqlite";
import type { Tab, AgentState } from "../../../src/types/shared";
import { getDirectory } from "./directories";

// Columns in db.rs table order.
const TAB_COLS =
  "id, directory_id, label, cwd, sort_order, created_at, last_agent_type, last_agent_session_id, last_agent_state, user_renamed";

type TabRow = {
  id: string;
  directory_id: string;
  label: string;
  cwd: string;
  sort_order: number;
  created_at: number;
  last_agent_type: string | null;
  last_agent_session_id: string | null;
  last_agent_state: string | null;
  user_renamed: number;
};

function rowToTab(row: TabRow): Tab {
  const tab: Tab = {
    id: row.id,
    directoryId: row.directory_id,
    label: row.label,
    cwd: row.cwd,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    userRenamed: row.user_renamed !== 0,
  };
  if (row.last_agent_type != null) tab.lastAgentType = row.last_agent_type;
  if (row.last_agent_session_id != null) tab.lastAgentSessionId = row.last_agent_session_id;
  if (row.last_agent_state != null) tab.lastAgentState = row.last_agent_state as AgentState;
  return tab;
}

export function insertTab(db: DatabaseSync, tab: Tab): void {
  db.prepare(
    `INSERT INTO tabs (${TAB_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    tab.id,
    tab.directoryId,
    tab.label,
    tab.cwd,
    tab.sortOrder,
    tab.createdAt,
    tab.lastAgentType ?? null,
    tab.lastAgentSessionId ?? null,
    tab.lastAgentState ?? null,
    tab.userRenamed ? 1 : 0,
  );
}

export function getTabs(db: DatabaseSync, directoryId?: string | null): Tab[] {
  if (directoryId != null) {
    return (
      db.prepare(
        `SELECT ${TAB_COLS} FROM tabs WHERE directory_id = ? ORDER BY sort_order, created_at`
      ).all(directoryId) as TabRow[]
    ).map(rowToTab);
  }
  return (
    db.prepare(
      `SELECT ${TAB_COLS} FROM tabs ORDER BY directory_id, sort_order, created_at`
    ).all() as TabRow[]
  ).map(rowToTab);
}

export function getTab(db: DatabaseSync, id: string): Tab | undefined {
  const row = db.prepare(`SELECT ${TAB_COLS} FROM tabs WHERE id = ?`).get(id) as TabRow | undefined;
  return row ? rowToTab(row) : undefined;
}

export function renameTab(db: DatabaseSync, id: string, label: string): void {
  db.prepare("UPDATE tabs SET label = ?, user_renamed = 1 WHERE id = ?").run(label, id);
}

export function reorderTabs(db: DatabaseSync, ids: string[]): void {
  const stmt = db.prepare("UPDATE tabs SET sort_order = ? WHERE id = ?");
  for (let i = 0; i < ids.length; i++) stmt.run(i, ids[i]);
}

export function deleteTab(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM tabs WHERE id = ?").run(id);
}

export function recordTabSession(
  db: DatabaseSync,
  sessionId: string,
  tabId: string,
  workingDir: string,
  agentType: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO tab_sessions (session_id, tab_id, agent_type, working_dir, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET last_seen_at = ?`
  ).run(sessionId, tabId, agentType, workingDir, now, now, now);
}

export function clearStaleTabStates(db: DatabaseSync, liveIds: string[]): void {
  if (liveIds.length === 0) {
    db.exec(
      "UPDATE tabs SET last_agent_type = NULL, last_agent_state = NULL, last_agent_session_id = NULL"
    );
    return;
  }
  const placeholders = liveIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE tabs SET last_agent_type = NULL, last_agent_state = NULL, last_agent_session_id = NULL WHERE id NOT IN (${placeholders})`
  ).run(...liveIds);
}

export function updateTabPresentationSnapshot(
  db: DatabaseSync,
  snapshot: {
    tabId: string;
    agentType: string | null;
    agentState: string | null;
    sessionId: string | null;
  },
): void {
  if (!snapshot.tabId) return;
  db.prepare(
    `UPDATE tabs
     SET last_agent_type = ?, last_agent_state = ?, last_agent_session_id = ?
     WHERE id = ?`,
  ).run(
    snapshot.agentType,
    snapshot.agentState,
    snapshot.sessionId,
    snapshot.tabId,
  );
}

export function tabDisplayLabels(
  db: DatabaseSync,
  tabId: string,
): { directoryName?: string; tabLabel?: string } {
  const tab = getTab(db, tabId);
  if (!tab) return {};
  const dir = getDirectory(db, tab.directoryId);
  return { directoryName: dir?.name, tabLabel: tab.label };
}

export function defaultLabel(existingCount: number): string {
  return String(existingCount + 1);
}

/** Count tabs that ran an agent (last_agent_type set). Resource monitor metric;
 *  Electron owns the tabs DB so it computes this (the sidecar no longer can). */
export function agentCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM tabs WHERE last_agent_type IS NOT NULL")
    .get() as { n: number };
  return row.n;
}
