import { DatabaseSync } from "node:sqlite";
import type { Tab, AgentState } from "../../../src/types/shared";
import { getDirectory } from "./directories";

// Columns in db.rs table order.
const TAB_COLS =
  "id, directory_id, label, cwd, sort_order, created_at, last_agent_type, last_agent_session_id, last_agent_state, user_renamed, scope_pinned_by_user, launch_command, archived_at, generated_title, display_title";

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
  scope_pinned_by_user: number;
  launch_command: string | null;
  archived_at: number | null;
  generated_title: string | null;
  display_title: string | null;
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
    scopePinnedByUser: row.scope_pinned_by_user !== 0,
  };
  if (row.last_agent_type != null) tab.lastAgentType = row.last_agent_type;
  if (row.last_agent_session_id != null) tab.lastAgentSessionId = row.last_agent_session_id;
  if (row.last_agent_state != null) tab.lastAgentState = row.last_agent_state as AgentState;
  if (row.launch_command != null) tab.launchCommand = row.launch_command;
  if (row.archived_at != null) tab.archivedAt = row.archived_at;
  if (row.generated_title != null) tab.generatedTitle = row.generated_title;
  if (row.display_title != null) tab.displayTitle = row.display_title;
  return tab;
}

export function insertTab(db: DatabaseSync, tab: Tab): void {
  db.prepare(
    `INSERT INTO tabs (${TAB_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    tab.scopePinnedByUser ? 1 : 0,
    tab.launchCommand ?? null,
    tab.archivedAt ?? null,
    tab.generatedTitle ?? null,
    tab.displayTitle ?? null,
  );
}

export function setTabArchivedAt(db: DatabaseSync, id: string, archivedAt: number | null): void {
  db.prepare("UPDATE tabs SET archived_at = ? WHERE id = ?").run(archivedAt, id);
}

/** Write the one-shot generated title. Only ever called when the column is
 *  still NULL (see session-title.ts) — non-null is the freeze flag. */
export function setTabGeneratedTitle(db: DatabaseSync, id: string, title: string): void {
  db.prepare("UPDATE tabs SET generated_title = ? WHERE id = ?").run(title, id);
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

/** Move UPDATE without txn — for callers composing a larger transaction. */
export function moveTabInsideOpenTxn(
  db: DatabaseSync,
  tabId: string,
  directoryId: string,
  cwd: string,
): void {
  db.prepare(
    `UPDATE tabs SET directory_id = ?, cwd = ?,
       sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tabs WHERE directory_id = ?)
     WHERE id = ?`,
  ).run(directoryId, cwd, directoryId, tabId);
}

/** Re-scope a tab: directory, cwd, append to destination sort order — one txn. */
export function moveTabToDirectory(
  db: DatabaseSync,
  tabId: string,
  directoryId: string,
  cwd: string,
): void {
  db.exec("BEGIN");
  try {
    moveTabInsideOpenTxn(db, tabId, directoryId, cwd);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function setTabScopePinned(db: DatabaseSync, tabId: string, pinned: boolean): void {
  db.prepare("UPDATE tabs SET scope_pinned_by_user = ? WHERE id = ?").run(pinned ? 1 : 0, tabId);
}

export function getTabScopePinned(db: DatabaseSync, tabId: string): boolean {
  const row = db
    .prepare("SELECT scope_pinned_by_user AS p FROM tabs WHERE id = ?")
    .get(tabId) as { p?: number } | undefined;
  return row?.p === 1;
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

/** A tab with no live PTY has no live agent state — clear the dot. Identity
 *  (`last_agent_type`, `last_agent_session_id`) is deliberately KEPT so an
 *  exited session stays resumable across a daemon restart; that used to be
 *  wiped here, which is why only archived sessions could resume. */
export function clearStaleTabStates(db: DatabaseSync, liveIds: string[]): void {
  if (liveIds.length === 0) {
    db.exec("UPDATE tabs SET last_agent_state = NULL WHERE archived_at IS NULL");
    return;
  }
  const placeholders = liveIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE tabs SET last_agent_state = NULL WHERE id NOT IN (${placeholders}) AND archived_at IS NULL`
  ).run(...liveIds);
}

/** Persist the last-known agent presentation for a tab.
 *
 *  LATCHING, deliberately: `last_agent_type`, `last_agent_session_id` and
 *  `display_title` only ever move to a non-null value. The daemon nulls all
 *  three the moment the agent stops being live (engine.rs identity-clear when a
 *  non-agent process takes the foreground pgrp), and its session-id assignment
 *  is unconditional, so a single hook payload missing `session_id` would erase
 *  a good id too. Both are correct for the LIVE status view and fatal for
 *  persistence — resume needs the type + id to outlive the process.
 *
 *  `last_agent_state` is the exception: it IS liveness, so it must be able to
 *  go null.
 *
 *  The identity is latched as a PAIR, atomically: when the incoming type differs
 *  from the stored one the agent genuinely changed, so the id and title are taken
 *  verbatim (including null) instead of coalesced. Independent COALESCEs would
 *  let type=codex keep a claude session id and resume `codex resume <claude-id>`. */
export function updateTabPresentationSnapshot(
  db: DatabaseSync,
  snapshot: {
    tabId: string;
    agentType: string | null;
    agentState: string | null;
    sessionId: string | null;
    displayTitle: string | null;
  },
): void {
  if (!snapshot.tabId) return;
  const prev = db
    .prepare("SELECT last_agent_type AS t FROM tabs WHERE id = ?")
    .get(snapshot.tabId) as { t: string | null } | undefined;
  if (!prev) return;
  const agentChanged =
    snapshot.agentType != null && prev.t != null && snapshot.agentType !== prev.t;
  db.prepare(
    agentChanged
      ? `UPDATE tabs
           SET last_agent_type       = ?,
               last_agent_session_id = ?,
               display_title         = ?,
               last_agent_state      = ?
           WHERE id = ?`
      : `UPDATE tabs
           SET last_agent_type       = COALESCE(?, last_agent_type),
               last_agent_session_id = COALESCE(?, last_agent_session_id),
               display_title         = COALESCE(?, display_title),
               last_agent_state      = ?
           WHERE id = ?`,
  ).run(
    snapshot.agentType,
    snapshot.sessionId,
    snapshot.displayTitle,
    snapshot.agentState,
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

/** Count tabs with a LIVE agent. Resource monitor metric; Electron owns the tabs
 *  DB so it computes this (the sidecar no longer can). Keyed on
 *  `last_agent_state` rather than `last_agent_type`, because the type is now
 *  latched and would otherwise count every tab that ever ran an agent.
 *  Archived tabs keep their state column but have no running process. */
export function agentCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM tabs WHERE last_agent_state IS NOT NULL AND archived_at IS NULL"
    )
    .get() as { n: number };
  return row.n;
}
