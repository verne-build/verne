import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { internalDataDir } from "../paths";

// Schema verbatim from daemon/crates/core/src/db.rs:init_db
const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS directories (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    repo_root TEXT,
    created_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS open_tabs (
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    tabs TEXT NOT NULL DEFAULT '[]',
    active_tab_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (scope_type, scope_id)
);
CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS recent_files (
    directory_id TEXT NOT NULL,
    path TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (directory_id, path)
);
CREATE TABLE IF NOT EXISTS sidebar_tabs (
    scope_type TEXT NOT NULL DEFAULT 'directory',
    directory_id TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    tab_type TEXT NOT NULL,
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    cursor_line INTEGER,
    cursor_column INTEGER,
    scroll_top REAL,
    PRIMARY KEY (scope_type, directory_id, tab_id)
);
CREATE TABLE IF NOT EXISTS sidebar_state (
    scope_type TEXT NOT NULL DEFAULT 'directory',
    directory_id TEXT NOT NULL,
    active_tab_id TEXT NOT NULL DEFAULT 'sc',
    list_column_width REAL DEFAULT 250,
    file_panel_active_id TEXT,
    right_sidebar_view TEXT,
    PRIMARY KEY (scope_type, directory_id)
);
CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY,
    directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    cwd TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_agent_type TEXT,
    last_agent_session_id TEXT,
    last_agent_state TEXT,
    user_renamed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tabs_dir ON tabs(directory_id);

CREATE TABLE IF NOT EXISTS tab_sessions (
    session_id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tab_sessions_tab ON tab_sessions(tab_id);

CREATE TABLE IF NOT EXISTS tab_groups (
    id TEXT PRIMARY KEY,
    directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active_pane_id TEXT,
    layout TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tab_groups_dir ON tab_groups(directory_id);

CREATE TABLE IF NOT EXISTS browser_favorites (
    workspace_root TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon_url TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_root, url)
);
CREATE TABLE IF NOT EXISTS browser_history (
    workspace_root TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon_url TEXT,
    visited_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_root, url)
);
CREATE INDEX IF NOT EXISTS idx_browser_history_visited
    ON browser_history(workspace_root, visited_at DESC);

DROP TABLE IF EXISTS autocomplete_cache;
`;

// Migrations that may need to run against an existing DB (from db.rs:init_db).
// Each is idempotent — guarded by a pragma_table_info check.
function runMigrations(db: DatabaseSync): void {
  function hasColumn(table: string, col: string): boolean {
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM pragma_table_info('${table}') WHERE name='${col}'`
    ).get() as { cnt: number } | undefined;
    return (row?.cnt ?? 0) > 0;
  }

  // recent_files old schema: 'dir' column → drop + recreate
  if (hasColumn("recent_files", "dir")) {
    db.exec(`DROP TABLE recent_files;
CREATE TABLE recent_files (
    directory_id TEXT NOT NULL,
    path TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (directory_id, path)
);`);
  }

  // sidebar_state: right_sidebar_view + file_panel_active_id
  if (!hasColumn("sidebar_state", "right_sidebar_view")) {
    db.exec(
      "ALTER TABLE sidebar_state ADD COLUMN right_sidebar_view TEXT;" +
      "ALTER TABLE sidebar_state ADD COLUMN file_panel_active_id TEXT;"
    );
  }

  // sidebar_tabs: diff metadata columns
  if (!hasColumn("sidebar_tabs", "diff_source")) {
    db.exec(
      "ALTER TABLE sidebar_tabs ADD COLUMN diff_source TEXT;" +
      "ALTER TABLE sidebar_tabs ADD COLUMN diff_rel_path TEXT;" +
      "ALTER TABLE sidebar_tabs ADD COLUMN diff_staged INTEGER;" +
      "ALTER TABLE sidebar_tabs ADD COLUMN diff_commit_id TEXT;" +
      "ALTER TABLE sidebar_tabs ADD COLUMN diff_commit_short_id TEXT;"
    );
  }

  // directories: parent_directory_id
  if (!hasColumn("directories", "parent_directory_id")) {
    db.exec(
      "ALTER TABLE directories ADD COLUMN parent_directory_id TEXT REFERENCES directories(id) ON DELETE CASCADE;"
    );
  }

  // tabs: last_agent_state
  if (!hasColumn("tabs", "last_agent_state")) {
    db.exec("ALTER TABLE tabs ADD COLUMN last_agent_state TEXT;");
  }

  // tabs: user_renamed
  if (!hasColumn("tabs", "user_renamed")) {
    db.exec("ALTER TABLE tabs ADD COLUMN user_renamed INTEGER NOT NULL DEFAULT 0;");
  }

  // directories: settings_json
  if (!hasColumn("directories", "settings_json")) {
    db.exec("ALTER TABLE directories ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';");
  }

  // scope_type on sidebar_tabs, sidebar_state, recent_files — gated per table
  for (const tbl of ["sidebar_tabs", "sidebar_state", "recent_files"] as const) {
    if (!hasColumn(tbl, "scope_type")) {
      db.exec(`ALTER TABLE ${tbl} ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'directory';`);
    }
  }

  // Drop FK on sidebar_tabs/sidebar_state.directory_id (reused as scope_id)
  const sidebarTabsSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sidebar_tabs'"
  ).get() as { sql: string } | undefined;
  if (sidebarTabsSql?.sql?.includes("REFERENCES directories")) {
    db.exec(
      "PRAGMA foreign_keys=OFF;" +
      "CREATE TABLE sidebar_tabs__new (" +
      "  scope_type TEXT NOT NULL DEFAULT 'directory'," +
      "  directory_id TEXT NOT NULL," +
      "  tab_id TEXT NOT NULL," +
      "  tab_type TEXT NOT NULL," +
      "  label TEXT NOT NULL," +
      "  position INTEGER NOT NULL," +
      "  cursor_line INTEGER," +
      "  cursor_column INTEGER," +
      "  scroll_top REAL," +
      "  diff_source TEXT," +
      "  diff_rel_path TEXT," +
      "  diff_staged INTEGER," +
      "  diff_commit_id TEXT," +
      "  diff_commit_short_id TEXT," +
      "  PRIMARY KEY (scope_type, directory_id, tab_id)" +
      ");" +
      "INSERT INTO sidebar_tabs__new " +
      "  SELECT scope_type, directory_id, tab_id, tab_type, label, position, cursor_line, cursor_column, scroll_top, diff_source, diff_rel_path, diff_staged, diff_commit_id, diff_commit_short_id FROM sidebar_tabs;" +
      "DROP TABLE sidebar_tabs;" +
      "ALTER TABLE sidebar_tabs__new RENAME TO sidebar_tabs;" +
      "CREATE TABLE sidebar_state__new (" +
      "  scope_type TEXT NOT NULL DEFAULT 'directory'," +
      "  directory_id TEXT NOT NULL," +
      "  active_tab_id TEXT NOT NULL DEFAULT 'sc'," +
      "  list_column_width REAL DEFAULT 250," +
      "  file_panel_active_id TEXT," +
      "  right_sidebar_view TEXT," +
      "  PRIMARY KEY (scope_type, directory_id)" +
      ");" +
      "INSERT INTO sidebar_state__new " +
      "  SELECT scope_type, directory_id, active_tab_id, list_column_width, file_panel_active_id, right_sidebar_view FROM sidebar_state;" +
      "DROP TABLE sidebar_state;" +
      "ALTER TABLE sidebar_state__new RENAME TO sidebar_state;" +
      "PRAGMA foreign_keys=ON;"
    );
  }

  // sidebar_tabs: browser_url + pinned
  if (!hasColumn("sidebar_tabs", "browser_url")) {
    db.exec("ALTER TABLE sidebar_tabs ADD COLUMN browser_url TEXT;");
  }
  if (!hasColumn("sidebar_tabs", "pinned")) {
    db.exec("ALTER TABLE sidebar_tabs ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT 0;");
  }

  // Migration: rename scratchpad→notes for app_state keys + sidebar_state values.
  {
    const done = db.prepare("SELECT value FROM app_state WHERE key = 'notes_rename_v1'").get() as { value: string } | undefined;
    if (!done) {
      db.exec(
        // Drop stale scratchpad_ rows whose notes_ equivalent already exists
        // (new renderer may have written notes_ keys before this ran) — else
        // the rename below hits UNIQUE on app_state.key and the migration loops.
        "DELETE FROM app_state WHERE key LIKE 'scratchpad_%' AND ('notes' || substr(key, 11)) IN (SELECT key FROM app_state);" +
        "UPDATE app_state SET key = 'notes' || substr(key, 11) WHERE key LIKE 'scratchpad_%';" +
        "UPDATE sidebar_state SET file_panel_active_id = '__notes__' WHERE file_panel_active_id = '__scratchpads__';" +
        "UPDATE sidebar_state SET right_sidebar_view = 'notes' WHERE right_sidebar_view = 'scratchpads';"
      );
      db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('notes_rename_v1', '1')").run();
    }
  }
}

export function openDb(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

let _db: DatabaseSync | null = null;
export function getDb(): DatabaseSync {
  if (!_db) {
    _db = openDb(join(internalDataDir, "verne.db"));
  }
  return _db;
}
