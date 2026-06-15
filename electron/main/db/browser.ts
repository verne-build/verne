import { DatabaseSync } from "node:sqlite";

export interface FavoriteRow {
  url: string;
  title: string;
  faviconUrl: string | null;
  addedAt: number;
}

export interface HistoryRow {
  url: string;
  title: string;
  faviconUrl: string | null;
  visitedAt: number;
}

export function addFavorite(
  db: DatabaseSync,
  workspaceRoot: string,
  url: string,
  title: string,
  faviconUrl: string | null,
): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR REPLACE INTO browser_favorites (workspace_root, url, title, favicon_url, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(workspaceRoot, url, title, faviconUrl, now);
}

export function removeFavorite(
  db: DatabaseSync,
  workspaceRoot: string,
  url: string,
): void {
  db.prepare(
    "DELETE FROM browser_favorites WHERE workspace_root = ? AND url = ?",
  ).run(workspaceRoot, url);
}

export function getFavorites(
  db: DatabaseSync,
  workspaceRoot: string,
): FavoriteRow[] {
  const rows = db
    .prepare(
      "SELECT url, title, favicon_url, added_at FROM browser_favorites WHERE workspace_root = ? ORDER BY added_at DESC",
    )
    .all(workspaceRoot) as { url: string; title: string; favicon_url: string | null; added_at: number }[];
  return rows.map(r => ({
    url: r.url,
    title: r.title,
    faviconUrl: r.favicon_url,
    addedAt: r.added_at,
  }));
}

export function recordHistory(
  db: DatabaseSync,
  workspaceRoot: string,
  url: string,
  title: string,
  faviconUrl: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO browser_history (workspace_root, url, title, favicon_url, visited_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_root, url) DO UPDATE SET visited_at = excluded.visited_at, title = excluded.title, favicon_url = excluded.favicon_url`,
  ).run(workspaceRoot, url, title, faviconUrl, now);
}

export function getHistory(
  db: DatabaseSync,
  workspaceRoot: string,
  limit = 500,
): HistoryRow[] {
  const rows = db
    .prepare(
      "SELECT url, title, favicon_url, visited_at FROM browser_history WHERE workspace_root = ? ORDER BY visited_at DESC LIMIT ?",
    )
    .all(workspaceRoot, limit) as { url: string; title: string; favicon_url: string | null; visited_at: number }[];
  return rows.map(r => ({
    url: r.url,
    title: r.title,
    faviconUrl: r.favicon_url,
    visitedAt: r.visited_at,
  }));
}

export function clearHistory(
  db: DatabaseSync,
  workspaceRoot: string,
): void {
  db.prepare(
    "DELETE FROM browser_history WHERE workspace_root = ?",
  ).run(workspaceRoot);
}

export function renameFavorite(
  db: DatabaseSync,
  workspaceRoot: string,
  url: string,
  title: string,
): void {
  db.prepare(
    "UPDATE browser_favorites SET title = ? WHERE workspace_root = ? AND url = ?",
  ).run(title, workspaceRoot, url);
}

export function removeHistory(
  db: DatabaseSync,
  workspaceRoot: string,
  url: string,
): void {
  db.prepare(
    "DELETE FROM browser_history WHERE workspace_root = ? AND url = ?",
  ).run(workspaceRoot, url);
}
