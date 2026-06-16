import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TabGroup } from "../../../src/types/shared";

type GroupDbRow = {
  id: string;
  directory_id: string;
  sort_order: number;
  active_pane_id: string | null;
  layout: string;
  created_at: number;
};

function rowToGroup(row: GroupDbRow): TabGroup {
  return {
    id: row.id,
    directoryId: row.directory_id,
    sortOrder: row.sort_order,
    activePaneId: row.active_pane_id ?? undefined,
    layout: row.layout,
    createdAt: row.created_at,
  };
}

export function insertGroup(db: DatabaseSync, g: TabGroup): void {
  db.prepare(
    `INSERT INTO tab_groups (id, directory_id, sort_order, active_pane_id, layout, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(g.id, g.directoryId, g.sortOrder, g.activePaneId ?? null, g.layout, g.createdAt);
}

export function getGroups(db: DatabaseSync, directoryId?: string | null): TabGroup[] {
  // Match Rust's opt_s: a null/absent arg means "all groups", not WHERE id = NULL.
  if (directoryId != null) {
    return (
      db
        .prepare(
          `SELECT id, directory_id, sort_order, active_pane_id, layout, created_at
           FROM tab_groups WHERE directory_id = ?
           ORDER BY sort_order, created_at`
        )
        .all(directoryId) as GroupDbRow[]
    ).map(rowToGroup);
  }
  return (
    db
      .prepare(
        `SELECT id, directory_id, sort_order, active_pane_id, layout, created_at
         FROM tab_groups ORDER BY directory_id, sort_order, created_at`
      )
      .all() as GroupDbRow[]
  ).map(rowToGroup);
}

export function nextGroupSortOrder(db: DatabaseSync, directoryId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tab_groups WHERE directory_id = ?"
    )
    .get(directoryId) as { next: number };
  return row.next;
}

export function createGroup(
  db: DatabaseSync,
  directoryId: string,
  layout: string,
  activePaneId?: string,
): TabGroup {
  const group: TabGroup = {
    id: randomUUID(),
    directoryId,
    sortOrder: nextGroupSortOrder(db, directoryId),
    activePaneId,
    layout,
    createdAt: Date.now(),
  };
  insertGroup(db, group);
  return group;
}

export function updateGroupLayout(
  db: DatabaseSync,
  id: string,
  layout: string,
  activePaneId?: string,
): void {
  db.prepare(
    "UPDATE tab_groups SET layout = ?, active_pane_id = COALESCE(?, active_pane_id) WHERE id = ?"
  ).run(layout, activePaneId ?? null, id);
}

export function setGroupLayout(
  db: DatabaseSync,
  id: string,
  layout: string,
  activePaneId: string | null,
): void {
  db.prepare(
    "UPDATE tab_groups SET layout = ?, active_pane_id = ? WHERE id = ?"
  ).run(layout, activePaneId, id);
}

export function setGroupActivePane(db: DatabaseSync, id: string, paneId: string): void {
  db.prepare("UPDATE tab_groups SET active_pane_id = ? WHERE id = ?").run(paneId, id);
}

export function reorderGroups(db: DatabaseSync, ids: string[]): void {
  const stmt = db.prepare("UPDATE tab_groups SET sort_order = ? WHERE id = ?");
  for (let i = 0; i < ids.length; i++) {
    stmt.run(i, ids[i]);
  }
}

export function deleteGroup(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM tab_groups WHERE id = ?").run(id);
}
