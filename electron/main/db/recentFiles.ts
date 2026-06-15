import { DatabaseSync } from "node:sqlite";

export function touchRecentFile(
  db: DatabaseSync,
  scopeType: string,
  scopeId: string,
  path: string,
): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR REPLACE INTO recent_files (scope_type, directory_id, path, opened_at) VALUES (?, ?, ?, ?)"
  ).run(scopeType, scopeId, path, now);
}

export function getRecentFiles(
  db: DatabaseSync,
  scopeType: string,
  scopeId: string,
): { path: string; openedAt: number }[] {
  const rows = db
    .prepare(
      "SELECT path, opened_at FROM recent_files WHERE scope_type = ? AND directory_id = ? ORDER BY opened_at DESC LIMIT 200"
    )
    .all(scopeType, scopeId) as { path: string; opened_at: number }[];
  return rows.map(r => ({ path: r.path, openedAt: r.opened_at }));
}
