import { DatabaseSync } from "node:sqlite";

export function getAppState(db: DatabaseSync, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setAppState(db: DatabaseSync, key: string, value: string | null): void {
  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(key, value);
}
