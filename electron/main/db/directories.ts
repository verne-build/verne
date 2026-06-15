import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { WorkingDirectory, DirectorySettings } from "../../../src/types/shared";

// Columns selected for WorkingDirectory rows (matches db.rs DIR_COLS ordering).
const DIR_COLS =
  "id, path, name, repo_root, created_at, sort_order, parent_directory_id";

type DirRow = {
  id: string;
  path: string;
  name: string;
  repo_root: string | null;
  created_at: number;
  sort_order: number;
  parent_directory_id: string | null;
};

function rowToDir(row: DirRow): WorkingDirectory {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    repoRoot: row.repo_root ?? undefined,
    createdAt: row.created_at,
    sortOrder: row.sort_order,
    parentDirectoryId: row.parent_directory_id ?? undefined,
  };
}

export function getDirectories(db: DatabaseSync): WorkingDirectory[] {
  return (
    db
      .prepare(`SELECT ${DIR_COLS} FROM directories ORDER BY sort_order, created_at`)
      .all() as DirRow[]
  ).map(rowToDir);
}

export function getDirectory(db: DatabaseSync, id: string): WorkingDirectory | null {
  const row = db
    .prepare(`SELECT ${DIR_COLS} FROM directories WHERE id = ?`)
    .get(id) as DirRow | undefined;
  return row ? rowToDir(row) : null;
}

export function resolveWorkspaceRoot(db: DatabaseSync, directoryId: string): string | null {
  let current = getDirectory(db, directoryId);
  if (!current) return null;
  for (let i = 0; i < 64; i++) {
    if (!current.parentDirectoryId) break;
    const parent = getDirectory(db, current.parentDirectoryId);
    if (!parent) break;
    current = parent;
  }
  return current.path;
}

export function insertDirectory(db: DatabaseSync, dir: WorkingDirectory): void {
  db.prepare(
    `INSERT INTO directories
      (id, path, name, repo_root, created_at, sort_order, parent_directory_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dir.id,
    dir.path,
    dir.name,
    dir.repoRoot ?? null,
    dir.createdAt,
    dir.sortOrder,
    dir.parentDirectoryId ?? null,
  );
}

export function createDirectory(db: DatabaseSync, path: string): WorkingDirectory {
  const home = homedir();
  const normalized = path.replace(/^~/, home);

  // Return existing if path already known
  const existing = db
    .prepare("SELECT id FROM directories WHERE path = ?")
    .get(normalized) as { id: string } | undefined;
  if (existing) {
    return getDirectory(db, existing.id)!;
  }

  const id = randomUUID();
  const name = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const now = Date.now();
  const maxSort = (
    db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM directories").get() as { m: number }
  ).m;

  db.prepare(
    `INSERT INTO directories (id, path, name, repo_root, created_at, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO NOTHING`
  ).run(id, normalized, name, null, now, maxSort + 1);

  // Re-read by path: ON CONFLICT means our id may not be the one stored.
  const row = db
    .prepare(`SELECT ${DIR_COLS} FROM directories WHERE path = ?`)
    .get(normalized) as DirRow;
  return rowToDir(row);
}

export function deleteDirectory(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM directories WHERE id = ?").run(id);
  return (result.changes ?? 0) > 0;
}

export function renameDirectory(
  db: DatabaseSync,
  id: string,
  name: string,
): WorkingDirectory | null {
  const result = db
    .prepare("UPDATE directories SET name = ? WHERE id = ?")
    .run(name, id);
  if ((result.changes ?? 0) === 0) return null;
  return getDirectory(db, id);
}

export function reorderDirectories(db: DatabaseSync, ids: string[]): void {
  const stmt = db.prepare("UPDATE directories SET sort_order = ? WHERE id = ?");
  for (let i = 0; i < ids.length; i++) {
    stmt.run(i, ids[i]);
  }
}

export function getDirectorySettings(db: DatabaseSync, dirId: string): DirectorySettings {
  const row = db
    .prepare("SELECT settings_json FROM directories WHERE id = ?")
    .get(dirId) as { settings_json: string } | undefined;
  const raw = row?.settings_json ?? "{}";
  try {
    return JSON.parse(raw) as DirectorySettings;
  } catch {
    return {};
  }
}

export function setDirectorySettings(
  db: DatabaseSync,
  dirId: string,
  settings: DirectorySettings,
): void {
  const json = JSON.stringify(settings);
  db.prepare("UPDATE directories SET settings_json = ? WHERE id = ?").run(json, dirId);
}
