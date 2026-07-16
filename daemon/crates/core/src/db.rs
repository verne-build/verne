use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;

use crate::types::*;

fn app_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("VERNE_APP_DATA_DIR") {
        return PathBuf::from(dir);
    }
    crate::paths::internal_data_dir()
}

pub fn db_path() -> PathBuf {
    app_data_dir().join("verne.db")
}

pub fn init_db(conn: &Connection) {
    // busy_timeout: host + daemon both write this WAL DB. Without it a writer
    // that hits the single-writer lock gets SQLITE_BUSY immediately, which then
    // panics the many `.unwrap()` call sites. Wait up to 5s for the lock first.
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    )
    .unwrap();

    conn.execute_batch(
        "
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
    ",
    )
    .unwrap();

    // Drop autocomplete_cache if it exists (feature removed)
    conn.execute_batch("DROP TABLE IF EXISTS autocomplete_cache;")
        .unwrap();

    // Migrate recent_files: old schema used 'dir' column, new uses 'directory_id'
    let has_dir_col: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('recent_files') WHERE name='dir'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if has_dir_col {
        conn.execute_batch("DROP TABLE recent_files;").unwrap();
        conn.execute_batch(
            "CREATE TABLE recent_files (
                directory_id TEXT NOT NULL,
                path TEXT NOT NULL,
                opened_at INTEGER NOT NULL,
                PRIMARY KEY (directory_id, path)
            );",
        )
        .unwrap();
    }

    // Sidebar state: split active_tab_id into right_sidebar_view + file_panel_active_id
    let has_right_view: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('sidebar_state') WHERE name='right_sidebar_view'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_right_view {
        conn.execute_batch(
            "ALTER TABLE sidebar_state ADD COLUMN right_sidebar_view TEXT;\
             ALTER TABLE sidebar_state ADD COLUMN file_panel_active_id TEXT;",
        )
        .unwrap();
    }

    // Sidebar tabs: add diff metadata columns so pinned diff tabs can persist.
    let has_diff_source: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('sidebar_tabs') WHERE name='diff_source'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_diff_source {
        conn.execute_batch(
            "ALTER TABLE sidebar_tabs ADD COLUMN diff_source TEXT;\
             ALTER TABLE sidebar_tabs ADD COLUMN diff_rel_path TEXT;\
             ALTER TABLE sidebar_tabs ADD COLUMN diff_staged INTEGER;\
             ALTER TABLE sidebar_tabs ADD COLUMN diff_commit_id TEXT;\
             ALTER TABLE sidebar_tabs ADD COLUMN diff_commit_short_id TEXT;",
        )
        .unwrap();
    }

    // Phase 7: parent_directory_id for worktree workspaces (each worktree is a
    // directories row whose parent is the source repo dir).
    let has_parent_dir: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('directories') WHERE name='parent_directory_id'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_parent_dir {
        conn.execute_batch(
            "ALTER TABLE directories ADD COLUMN parent_directory_id TEXT REFERENCES directories(id) ON DELETE CASCADE;",
        ).unwrap();
    }

    // tabs.last_agent_state — persist the agent state across app reloads so
    // dots stay correct until the next hook/detect tick updates them.
    let has_tab_state: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name='last_agent_state'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_tab_state {
        conn.execute_batch("ALTER TABLE tabs ADD COLUMN last_agent_state TEXT;")
            .unwrap();
    }

    // Add user_renamed flag to tabs (locks the label against auto-naming).
    let has_user_renamed: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name='user_renamed'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_user_renamed {
        conn.execute_batch("ALTER TABLE tabs ADD COLUMN user_renamed INTEGER NOT NULL DEFAULT 0;")
            .unwrap();
    }

    // Directories: per-directory settings JSON blob
    let has_dir_settings: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('directories') WHERE name='settings_json'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_dir_settings {
        conn.execute_batch(
            "ALTER TABLE directories ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';",
        )
        .unwrap();
    }

    // sidebar_tabs / sidebar_state / recent_files: scope_type column for
    // distinguishing directory-rooted state from agent-worktree-rooted state.
    // Gate each table independently — sidebar_tabs/sidebar_state are created
    // WITH scope_type, recent_files is not, so a shared gate would skip it.
    for tbl in ["sidebar_tabs", "sidebar_state", "recent_files"] {
        let has_scope: bool = conn
            .prepare(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('{tbl}') WHERE name='scope_type'"
            ))
            .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_scope {
            conn.execute_batch(&format!(
                "ALTER TABLE {tbl} ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'directory';"
            ))
            .unwrap();
        }
    }

    // Drop FK on sidebar_tabs/sidebar_state.directory_id — that column is
    // now reused as scope_id, which holds an agent id for agent_worktree rows
    // and would otherwise fail the directories(id) FK.
    let needs_fk_drop: bool = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='sidebar_tabs'",
            [],
            |r| r.get::<_, String>(0),
        )
        .map(|sql: String| sql.contains("REFERENCES directories"))
        .unwrap_or(false);
    if needs_fk_drop {
        conn.execute_batch(
            "PRAGMA foreign_keys=OFF;\
             CREATE TABLE sidebar_tabs__new (\
                 scope_type TEXT NOT NULL DEFAULT 'directory',\
                 directory_id TEXT NOT NULL,\
                 tab_id TEXT NOT NULL,\
                 tab_type TEXT NOT NULL,\
                 label TEXT NOT NULL,\
                 position INTEGER NOT NULL,\
                 cursor_line INTEGER,\
                 cursor_column INTEGER,\
                 scroll_top REAL,\
                 diff_source TEXT,\
                 diff_rel_path TEXT,\
                 diff_staged INTEGER,\
                 diff_commit_id TEXT,\
                 diff_commit_short_id TEXT,\
                 PRIMARY KEY (scope_type, directory_id, tab_id)\
             );\
             INSERT INTO sidebar_tabs__new \
                 SELECT scope_type, directory_id, tab_id, tab_type, label, position, cursor_line, cursor_column, scroll_top, diff_source, diff_rel_path, diff_staged, diff_commit_id, diff_commit_short_id FROM sidebar_tabs;\
             DROP TABLE sidebar_tabs;\
             ALTER TABLE sidebar_tabs__new RENAME TO sidebar_tabs;\
             CREATE TABLE sidebar_state__new (\
                 scope_type TEXT NOT NULL DEFAULT 'directory',\
                 directory_id TEXT NOT NULL,\
                 active_tab_id TEXT NOT NULL DEFAULT 'sc',\
                 list_column_width REAL DEFAULT 250,\
                 file_panel_active_id TEXT,\
                 right_sidebar_view TEXT,\
                 PRIMARY KEY (scope_type, directory_id)\
             );\
             INSERT INTO sidebar_state__new \
                 SELECT scope_type, directory_id, active_tab_id, list_column_width, file_panel_active_id, right_sidebar_view FROM sidebar_state;\
             DROP TABLE sidebar_state;\
             ALTER TABLE sidebar_state__new RENAME TO sidebar_state;\
             PRAGMA foreign_keys=ON;",
        ).unwrap();
    }

    // sidebar_tabs: browser_url + pinned for browser tab persistence.
    let has_browser_url: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('sidebar_tabs') WHERE name='browser_url'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_browser_url {
        let _ = conn.execute("ALTER TABLE sidebar_tabs ADD COLUMN browser_url TEXT", []);
    }
    let has_pinned: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('sidebar_tabs') WHERE name='pinned'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_pinned {
        let _ = conn.execute(
            "ALTER TABLE sidebar_tabs ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT 0",
            [],
        );
    }

    // NOTE: tab→group backfill is owned by the frontend (`ingestGroups` in the
    // workspace store), which on every load creates + persists a single-pane
    // group for any tab not covered by an existing group's layout. Doing it
    // there avoids a host/daemon double-run race on this shared DB.
}

pub fn detect_branch(working_dir: &str) -> Option<String> {
    // libgit2, not a `git` shell-out: bundled .app launches lack `git` on PATH
    // (same reason as resolve_repo_root above).
    let repo = git2::Repository::discover(working_dir).ok()?;
    let head = repo.head().ok()?;
    head.shorthand().map(|s| s.to_string())
}

// --- Directory CRUD ---

fn row_to_dir(row: &rusqlite::Row) -> rusqlite::Result<WorkingDirectory> {
    Ok(WorkingDirectory {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        repo_root: row.get(3)?,
        created_at: row.get(4)?,
        sort_order: row.get(5)?,
        parent_directory_id: row.get(6)?,
    })
}

const DIR_COLS: &str = "id, path, name, repo_root, created_at, sort_order, parent_directory_id";

pub fn get_directories(conn: &Connection) -> Vec<WorkingDirectory> {
    let sql = format!("SELECT {DIR_COLS} FROM directories ORDER BY sort_order, created_at");
    let mut stmt = conn.prepare(&sql).unwrap();
    stmt.query_map([], row_to_dir)
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
}

pub fn get_directory(conn: &Connection, id: &str) -> Option<WorkingDirectory> {
    let sql = format!("SELECT {DIR_COLS} FROM directories WHERE id = ?");
    conn.query_row(&sql, params![id], row_to_dir)
        .optional()
        .unwrap()
}

/// Resolve a directory to its workspace ROOT path by walking `parent_directory_id`
/// up the tree (worktrees nest under a parent). Returns the topmost directory's
/// path. Used to key notes storage so a worktree shares its parent's notes.
/// Cycle-guarded; falls back to the directory's own path.
pub fn resolve_workspace_root(conn: &Connection, directory_id: &str) -> Option<String> {
    let mut current = get_directory(conn, directory_id)?;
    for _ in 0..64 {
        match current.parent_directory_id.clone() {
            Some(parent_id) => match get_directory(conn, &parent_id) {
                Some(parent) => current = parent,
                None => break,
            },
            None => break,
        }
    }
    Some(current.path)
}

/// Phase 7: full-control directory insert (used by worktree creation, which
/// supplies its own id/path/parent_directory_id). `create_directory` derives
/// fields from a path; this one trusts the caller.
pub fn insert_directory(conn: &Connection, dir: &WorkingDirectory) {
    conn.execute(
        "INSERT INTO directories
            (id, path, name, repo_root, created_at, sort_order, parent_directory_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            dir.id,
            dir.path,
            dir.name,
            dir.repo_root,
            dir.created_at,
            dir.sort_order,
            dir.parent_directory_id,
        ],
    )
    .unwrap();
}

pub fn get_directory_settings(conn: &Connection, dir_id: &str) -> crate::types::DirectorySettings {
    let raw: String = conn
        .query_row(
            "SELECT settings_json FROM directories WHERE id = ?",
            params![dir_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn set_directory_settings(
    conn: &Connection,
    dir_id: &str,
    settings: &crate::types::DirectorySettings,
) {
    let json = serde_json::to_string(settings).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "UPDATE directories SET settings_json = ? WHERE id = ?",
        params![json, dir_id],
    )
    .ok();
}

pub fn create_directory(conn: &Connection, path: &str) -> WorkingDirectory {
    let home = dirs::home_dir().expect("no home dir");
    let normalized = path.replace("~", &home.to_string_lossy());

    // Check if already exists
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM directories WHERE path = ?",
            params![normalized],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .unwrap()
    {
        return get_directory(conn, &existing).unwrap();
    }

    let id = uuid::Uuid::new_v4().to_string();
    let name = std::path::Path::new(&normalized)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| normalized.clone());
    let repo_root_opt = crate::services::git::resolve_repo_root(&normalized);
    let now = chrono::Utc::now().timestamp_millis();
    let max_sort: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM directories",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO directories (id, path, name, repo_root, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING",
        params![id, normalized, name, repo_root_opt, now, max_sort + 1],
    )
    .unwrap();

    // Read back by path, not id: on a UNIQUE(path) conflict our insert is a
    // no-op and the pre-existing row keeps its original id.
    conn.query_row(
        &format!("SELECT {DIR_COLS} FROM directories WHERE path = ?"),
        params![normalized],
        row_to_dir,
    )
    .unwrap()
}

pub fn delete_directory(conn: &Connection, id: &str) -> bool {
    conn.execute("DELETE FROM directories WHERE id = ?", params![id])
        .unwrap()
        > 0
}

pub fn rename_directory(conn: &Connection, id: &str, name: &str) -> Option<WorkingDirectory> {
    let updated = conn
        .execute(
            "UPDATE directories SET name = ? WHERE id = ?",
            params![name, id],
        )
        .unwrap();
    if updated > 0 {
        get_directory(conn, id)
    } else {
        None
    }
}

pub fn reorder_directories(conn: &Connection, ids: &[String]) {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE directories SET sort_order = ? WHERE id = ?",
            params![i as i64, id],
        )
        .unwrap();
    }
}

// --- App State ---

pub fn get_app_state(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_state WHERE key = ?",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

pub fn set_app_state(conn: &Connection, key: &str, value: Option<&str>) {
    conn.execute(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)",
        params![key, value],
    )
    .unwrap();
}

// --- Editor tabs (open_tabs table) ---

pub fn get_editor_tabs(
    conn: &Connection,
    scope_type: &str,
    scope_id: &str,
) -> Option<StoredTabState> {
    conn.query_row(
        "SELECT tabs, active_tab_id FROM open_tabs WHERE scope_type = ? AND scope_id = ?",
        params![scope_type, scope_id],
        |row| {
            let tabs_json: String = row.get(0)?;
            let active_tab_id: String = row.get(1)?;
            let tabs: Vec<StoredTab> = serde_json::from_str(&tabs_json).unwrap_or_default();
            Ok(StoredTabState {
                tabs,
                active_tab_id,
            })
        },
    )
    .optional()
    .unwrap()
}

// --- Recent Files ---

pub fn touch_recent_file(conn: &Connection, scope_type: &str, scope_id: &str, path: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR REPLACE INTO recent_files (scope_type, directory_id, path, opened_at) VALUES (?, ?, ?, ?)",
        params![scope_type, scope_id, path, now],
    )
    .unwrap();
}

pub fn get_recent_files(conn: &Connection, scope_type: &str, scope_id: &str) -> Vec<(String, i64)> {
    let mut stmt = conn
        .prepare("SELECT path, opened_at FROM recent_files WHERE scope_type = ? AND directory_id = ? ORDER BY opened_at DESC LIMIT 200")
        .unwrap();
    stmt.query_map(params![scope_type, scope_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_editor_tabs(
    conn: &Connection,
    scope_type: &str,
    scope_id: &str,
    state: &StoredTabState,
) {
    let tabs_json = serde_json::to_string(&state.tabs).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO open_tabs (scope_type, scope_id, tabs, active_tab_id) VALUES (?, ?, ?, ?)",
        params![scope_type, scope_id, tabs_json, state.active_tab_id],
    )
    .unwrap();
}

// --- Sidebar tabs + state ---

pub fn get_sidebar_tabs(conn: &Connection, scope_type: &str, scope_id: &str) -> Vec<SidebarTabRow> {
    let mut stmt = conn
        .prepare(
            "SELECT directory_id, tab_id, tab_type, label, position, cursor_line, cursor_column, scroll_top, diff_source, diff_rel_path, diff_staged, diff_commit_id, diff_commit_short_id, browser_url, pinned FROM sidebar_tabs WHERE scope_type = ? AND directory_id = ? ORDER BY position",
        )
        .unwrap();
    stmt.query_map(params![scope_type, scope_id], |row| {
        Ok(SidebarTabRow {
            directory_id: row.get(0)?,
            tab_id: row.get(1)?,
            tab_type: row.get(2)?,
            label: row.get(3)?,
            position: row.get(4)?,
            cursor_line: row.get(5)?,
            cursor_column: row.get(6)?,
            scroll_top: row.get(7)?,
            diff_source: row.get(8)?,
            diff_rel_path: row.get(9)?,
            diff_staged: row.get::<_, Option<i64>>(10)?.map(|v| v != 0),
            diff_commit_id: row.get(11)?,
            diff_commit_short_id: row.get(12)?,
            browser_url: row.get(13)?,
            pinned: row
                .get::<_, Option<i64>>(14)?
                .map(|v| v != 0)
                .unwrap_or(false),
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_sidebar_tabs(
    conn: &Connection,
    scope_type: &str,
    scope_id: &str,
    tabs: &[SidebarTabRow],
    active_tab_id: &str,
    list_column_width: f64,
    right_sidebar_view: Option<&str>,
    file_panel_active_id: Option<&str>,
) {
    conn.execute(
        "DELETE FROM sidebar_tabs WHERE scope_type = ? AND directory_id = ?",
        params![scope_type, scope_id],
    )
    .unwrap();
    for tab in tabs {
        conn.execute(
            "INSERT INTO sidebar_tabs (scope_type, directory_id, tab_id, tab_type, label, position, cursor_line, cursor_column, scroll_top, diff_source, diff_rel_path, diff_staged, diff_commit_id, diff_commit_short_id, browser_url, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                scope_type,
                scope_id,
                tab.tab_id,
                tab.tab_type,
                tab.label,
                tab.position,
                tab.cursor_line,
                tab.cursor_column,
                tab.scroll_top,
                tab.diff_source,
                tab.diff_rel_path,
                tab.diff_staged.map(|b| if b { 1i64 } else { 0i64 }),
                tab.diff_commit_id,
                tab.diff_commit_short_id,
                tab.browser_url,
                if tab.pinned { 1i64 } else { 0i64 },
            ],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT OR REPLACE INTO sidebar_state (scope_type, directory_id, active_tab_id, list_column_width, right_sidebar_view, file_panel_active_id) VALUES (?, ?, ?, ?, ?, ?)",
        params![scope_type, scope_id, active_tab_id, list_column_width, right_sidebar_view, file_panel_active_id],
    )
    .unwrap();
}

pub fn get_sidebar_state(
    conn: &Connection,
    scope_type: &str,
    scope_id: &str,
) -> Option<SidebarState> {
    conn.query_row(
        "SELECT directory_id, active_tab_id, list_column_width, right_sidebar_view, file_panel_active_id FROM sidebar_state WHERE scope_type = ? AND directory_id = ?",
        params![scope_type, scope_id],
        |row| {
            Ok(SidebarState {
                directory_id: row.get(0)?,
                active_tab_id: row.get(1)?,
                list_column_width: row.get::<_, Option<f64>>(2)?.unwrap_or(250.0),
                right_sidebar_view: row.get::<_, Option<String>>(3)?,
                file_panel_active_id: row.get::<_, Option<String>>(4)?,
            })
        },
    )
    .optional()
    .unwrap()
}

// --- Tabs (terminal tabs) ---

pub fn insert_tab(conn: &Connection, tab: &Tab) {
    conn.execute(
        "INSERT INTO tabs (id, directory_id, label, cwd, sort_order, created_at, last_agent_type, last_agent_session_id, last_agent_state, user_renamed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![tab.id, tab.directory_id, tab.label, tab.cwd, tab.sort_order,
                tab.created_at, tab.last_agent_type, tab.last_agent_session_id, tab.last_agent_state,
                tab.user_renamed as i64],
    ).unwrap();
}

pub fn get_tabs(conn: &Connection, directory_id: Option<&str>) -> Vec<Tab> {
    let map_row = |r: &rusqlite::Row<'_>| {
        Ok(Tab {
            id: r.get(0)?,
            directory_id: r.get(1)?,
            label: r.get(2)?,
            cwd: r.get(3)?,
            sort_order: r.get(4)?,
            created_at: r.get(5)?,
            last_agent_type: r.get(6)?,
            last_agent_session_id: r.get(7)?,
            last_agent_state: r.get(8)?,
            user_renamed: r.get::<_, i64>(9)? != 0,
        })
    };
    match directory_id {
        Some(d) => {
            let mut s = conn.prepare(
                "SELECT id, directory_id, label, cwd, sort_order, created_at, last_agent_type, last_agent_session_id, last_agent_state, user_renamed
                 FROM tabs WHERE directory_id = ?1 ORDER BY sort_order, created_at"
            ).unwrap();
            s.query_map([d], map_row)
                .unwrap()
                .filter_map(|r| r.ok())
                .collect()
        }
        None => {
            let mut s = conn.prepare(
                "SELECT id, directory_id, label, cwd, sort_order, created_at, last_agent_type, last_agent_session_id, last_agent_state, user_renamed
                 FROM tabs ORDER BY directory_id, sort_order, created_at"
            ).unwrap();
            s.query_map([], map_row)
                .unwrap()
                .filter_map(|r| r.ok())
                .collect()
        }
    }
}

pub fn get_tab(conn: &Connection, id: &str) -> Option<Tab> {
    conn.query_row(
        "SELECT id, directory_id, label, cwd, sort_order, created_at, last_agent_type, last_agent_session_id, last_agent_state, user_renamed
         FROM tabs WHERE id = ?1",
        [id],
        |r| Ok(Tab {
            id: r.get(0)?,
            directory_id: r.get(1)?,
            label: r.get(2)?,
            cwd: r.get(3)?,
            sort_order: r.get(4)?,
            created_at: r.get(5)?,
            last_agent_type: r.get(6)?,
            last_agent_session_id: r.get(7)?,
            last_agent_state: r.get(8)?,
            user_renamed: r.get::<_, i64>(9)? != 0,
        })
    ).optional().unwrap()
}

/// Update the persisted agent state for a tab. Called on every state emit
/// (hook + detect) so a fresh app start reads the latest value via get_tabs.
pub fn set_tab_state(conn: &Connection, tab_id: &str, state: &str) {
    let _ = conn.execute(
        "UPDATE tabs SET last_agent_state = ?2 WHERE id = ?1",
        params![tab_id, state],
    );
}

/// Clear all persisted agent metadata. Called at daemon startup since the
/// PTYs died with the previous daemon process — the fresh shells respawned
/// by `ensure_tab_session` start empty, so no tab has a running agent until
/// the detection loop re-identifies one.
pub fn clear_all_tab_states(conn: &Connection) {
    let _ = conn.execute(
        "UPDATE tabs SET last_agent_type = NULL, last_agent_state = NULL, last_agent_session_id = NULL",
        [],
    );
}

/// Reconcile persisted agent metadata against the daemon's live sessions.
/// Clears agent state for every tab whose id is NOT in `live_ids` (its PTY died
/// with a previous daemon), while preserving tabs the persistent daemon still
/// has running. With an empty `live_ids` this is equivalent to
/// `clear_all_tab_states`.
pub fn clear_stale_tab_states(conn: &Connection, live_ids: &[String]) {
    if live_ids.is_empty() {
        clear_all_tab_states(conn);
        return;
    }
    let placeholders = live_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "UPDATE tabs SET last_agent_type = NULL, last_agent_state = NULL, last_agent_session_id = NULL \
         WHERE id NOT IN ({placeholders})"
    );
    let params: Vec<&dyn rusqlite::ToSql> =
        live_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let _ = conn.execute(&sql, params.as_slice());
}

pub fn rename_tab(conn: &Connection, id: &str, label: &str) {
    conn.execute(
        "UPDATE tabs SET label = ?2, user_renamed = 1 WHERE id = ?1",
        params![id, label],
    )
    .unwrap();
}

pub fn reorder_tabs(conn: &Connection, ids: &[String]) {
    for (i, id) in ids.iter().enumerate() {
        let _ = conn.execute(
            "UPDATE tabs SET sort_order = ?2 WHERE id = ?1",
            params![id, i as i64],
        );
    }
}

pub fn delete_tab(conn: &Connection, id: &str) {
    conn.execute("DELETE FROM tabs WHERE id = ?1", [id])
        .unwrap();
}

// --- Tab group (split layout) CRUD ---

pub fn insert_group(conn: &Connection, g: &TabGroup) {
    conn.execute(
        "INSERT INTO tab_groups (id, directory_id, sort_order, active_pane_id, layout, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            g.id,
            g.directory_id,
            g.sort_order,
            g.active_pane_id,
            g.layout,
            g.created_at
        ],
    )
    .unwrap();
}

pub fn get_groups(conn: &Connection, directory_id: Option<&str>) -> Vec<TabGroup> {
    let map_row = |r: &rusqlite::Row<'_>| {
        Ok(TabGroup {
            id: r.get(0)?,
            directory_id: r.get(1)?,
            sort_order: r.get(2)?,
            active_pane_id: r.get(3)?,
            layout: r.get(4)?,
            created_at: r.get(5)?,
        })
    };
    match directory_id {
        Some(d) => {
            let mut s = conn
                .prepare(
                    "SELECT id, directory_id, sort_order, active_pane_id, layout, created_at
                 FROM tab_groups WHERE directory_id = ?1 ORDER BY sort_order, created_at",
                )
                .unwrap();
            s.query_map([d], map_row)
                .unwrap()
                .filter_map(|r| r.ok())
                .collect()
        }
        None => {
            let mut s = conn
                .prepare(
                    "SELECT id, directory_id, sort_order, active_pane_id, layout, created_at
                 FROM tab_groups ORDER BY directory_id, sort_order, created_at",
                )
                .unwrap();
            s.query_map([], map_row)
                .unwrap()
                .filter_map(|r| r.ok())
                .collect()
        }
    }
}

pub fn next_group_sort_order(conn: &Connection, directory_id: &str) -> i64 {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tab_groups WHERE directory_id = ?1",
        [directory_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn update_group_layout(
    conn: &Connection,
    id: &str,
    layout: &str,
    active_pane_id: Option<&str>,
) {
    conn.execute(
        "UPDATE tab_groups SET layout = ?2, active_pane_id = COALESCE(?3, active_pane_id) WHERE id = ?1",
        params![id, layout, active_pane_id],
    ).unwrap();
}

pub fn set_group_active_pane(conn: &Connection, id: &str, pane_id: &str) {
    conn.execute(
        "UPDATE tab_groups SET active_pane_id = ?2 WHERE id = ?1",
        params![id, pane_id],
    )
    .unwrap();
}

pub fn reorder_groups(conn: &Connection, ids: &[String]) {
    for (i, id) in ids.iter().enumerate() {
        let _ = conn.execute(
            "UPDATE tab_groups SET sort_order = ?2 WHERE id = ?1",
            params![id, i as i64],
        );
    }
}

pub fn delete_group(conn: &Connection, id: &str) {
    conn.execute("DELETE FROM tab_groups WHERE id = ?1", [id])
        .unwrap();
}

pub fn record_tab_session(
    conn: &Connection,
    session_id: &str,
    tab_id: &str,
    working_dir: &str,
    agent_type: &str,
) {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO tab_sessions (session_id, tab_id, agent_type, working_dir, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(session_id) DO UPDATE SET last_seen_at = ?5",
        params![session_id, tab_id, agent_type, working_dir, now],
    ).unwrap();
}

pub fn tab_id_for_session(conn: &Connection, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT tab_id FROM tab_sessions WHERE session_id = ?1",
        [session_id],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
}

pub fn latest_tab_session(conn: &Connection, tab_id: &str) -> Option<TabSessionRow> {
    conn.query_row(
        "SELECT session_id, tab_id, agent_type, working_dir, created_at, last_seen_at
         FROM tab_sessions WHERE tab_id = ?1 ORDER BY last_seen_at DESC LIMIT 1",
        [tab_id],
        |r| {
            Ok(TabSessionRow {
                session_id: r.get(0)?,
                tab_id: r.get(1)?,
                agent_type: r.get(2)?,
                working_dir: r.get(3)?,
                created_at: r.get(4)?,
                last_seen_at: r.get(5)?,
            })
        },
    )
    .optional()
    .unwrap()
}

#[cfg(test)]
mod user_renamed_tests {
    use super::*;
    use crate::types::{Tab, WorkingDirectory};

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn);
        conn
    }

    fn make_dir(conn: &Connection) -> String {
        let dir = WorkingDirectory {
            id: "dir1".into(),
            path: "/tmp/dir1".into(),
            name: "dir1".into(),
            repo_root: None,
            created_at: 0,
            sort_order: 0,
            parent_directory_id: None,
        };
        insert_directory(conn, &dir);
        dir.id
    }

    fn make_tab(dir_id: &str) -> Tab {
        Tab {
            id: "tab1".into(),
            directory_id: dir_id.into(),
            label: "1".into(),
            cwd: "/tmp/dir1".into(),
            sort_order: 0,
            created_at: 0,
            last_agent_type: None,
            last_agent_session_id: None,
            last_agent_state: None,
            user_renamed: false,
        }
    }

    #[test]
    fn rename_sets_user_renamed_flag() {
        let conn = mem_db();
        let dir_id = make_dir(&conn);
        let tab = make_tab(&dir_id);
        insert_tab(&conn, &tab);
        assert!(!get_tab(&conn, &tab.id).unwrap().user_renamed);

        rename_tab(&conn, &tab.id, "my-name");
        let got = get_tab(&conn, &tab.id).unwrap();
        assert_eq!(got.label, "my-name");
        assert!(got.user_renamed);
    }

    #[test]
    fn fresh_tab_defaults_to_not_renamed() {
        let conn = mem_db();
        let dir_id = make_dir(&conn);
        let tab = make_tab(&dir_id);
        insert_tab(&conn, &tab);
        let tabs = get_tabs(&conn, Some(&dir_id));
        assert_eq!(tabs.len(), 1);
        assert!(!tabs[0].user_renamed);
    }
}
