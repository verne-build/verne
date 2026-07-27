import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./connection";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-db-"));
  return openDb(join(dir, "verne.db"));
}

describe("openDb", () => {
  it("opens and runs schema without error", () => {
    const db = tmpDb();
    expect(db).toBeTruthy();
  });

  it("tables exist after open", () => {
    const db = tmpDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("directories");
    expect(names).toContain("tabs");
    expect(names).toContain("tab_groups");
    expect(names).toContain("app_state");
    expect(names).toContain("recent_files");
    expect(names).toContain("sidebar_tabs");
    expect(names).toContain("sidebar_state");
    expect(names).toContain("open_tabs");
    expect(names).toContain("tab_snapshots");
  });

  it("fresh tabs table has archived_at column", () => {
    const db = tmpDb();
    const cols = db.prepare("SELECT name FROM pragma_table_info('tabs')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("archived_at");
  });

  it("round-trips a row in app_state", () => {
    const db = tmpDb();
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("testKey", "testVal");
    const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get("testKey") as { value: string };
    expect(row.value).toBe("testVal");
  });

  it("is idempotent (double open does not error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-db-idem-"));
    const path = join(dir, "verne.db");
    openDb(path);
    openDb(path); // second open should not throw
  });

  it("migrates launch_command onto an existing tabs table", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-db-launch-command-"));
    const path = join(dir, "verne.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE tabs (
      id TEXT PRIMARY KEY, directory_id TEXT NOT NULL, label TEXT NOT NULL,
      cwd TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      last_agent_type TEXT, last_agent_session_id TEXT, last_agent_state TEXT,
      user_renamed INTEGER NOT NULL DEFAULT 0, scope_pinned_by_user INTEGER NOT NULL DEFAULT 0
    )`);
    old.close();
    const migrated = openDb(path);
    const cols = migrated.prepare("SELECT name FROM pragma_table_info('tabs')").all() as { name: string }[];
    expect(cols.map((col) => col.name)).toContain("launch_command");
  });

  it("migrates archived_at + tab_snapshots onto an existing tabs table, exactly once across two opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-db-archive-migrate-"));
    const path = join(dir, "verne.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE tabs (
      id TEXT PRIMARY KEY, directory_id TEXT NOT NULL, label TEXT NOT NULL,
      cwd TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      last_agent_type TEXT, last_agent_session_id TEXT, last_agent_state TEXT,
      user_renamed INTEGER NOT NULL DEFAULT 0, scope_pinned_by_user INTEGER NOT NULL DEFAULT 0,
      launch_command TEXT
    )`);
    old.close();
    openDb(path);
    const migrated = openDb(path); // second open must not re-add the column or re-create the table
    const cols = migrated.prepare("SELECT name FROM pragma_table_info('tabs')").all() as { name: string }[];
    expect(cols.filter((col) => col.name === "archived_at")).toHaveLength(1);
    const tables = migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tab_snapshots'"
    ).all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("renames scratchpad app_state keys to notes on first open", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-db-notes-migrate-"));
    const path = join(dir, "verne.db");
    const db = openDb(path);
    db.prepare("DELETE FROM app_state WHERE key = 'notes_rename_v1'").run();
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("scratchpad_list_px", "220");
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("scratchpad_editor_prefs", "{\"wordWrap\":true}");
    openDb(path);
    const listPx = db.prepare("SELECT value FROM app_state WHERE key = ?").get("notes_list_px") as { value: string };
    const prefs = db.prepare("SELECT value FROM app_state WHERE key = ?").get("notes_editor_prefs") as { value: string };
    expect(listPx.value).toBe("220");
    expect(prefs.value).toBe("{\"wordWrap\":true}");
    const old = db.prepare("SELECT key FROM app_state WHERE key LIKE 'scratchpad_%'").all();
    expect(old).toHaveLength(0);
  });

  it("survives a scratchpad/notes key collision (notes value wins)", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-db-notes-collide-"));
    const path = join(dir, "verne.db");
    const db = openDb(path);
    db.prepare("DELETE FROM app_state WHERE key = 'notes_rename_v1'").run();
    // both old + new keys present (new renderer wrote notes_ before migration ran)
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("scratchpad_list_px", "OLD");
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("notes_list_px", "NEW");
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run("scratchpad_editor_prefs", "{}");
    openDb(path); // must not throw UNIQUE constraint
    const listPx = db.prepare("SELECT value FROM app_state WHERE key = ?").get("notes_list_px") as { value: string };
    expect(listPx.value).toBe("NEW"); // newer notes value preserved
    const old = db.prepare("SELECT key FROM app_state WHERE key LIKE 'scratchpad_%'").all();
    expect(old).toHaveLength(0); // stale scratchpad rows gone
    const flag = db.prepare("SELECT value FROM app_state WHERE key = 'notes_rename_v1'").get();
    expect(flag).toBeTruthy(); // migration completed, no boot loop
  });

  it("migrates sidebar_state scratchpad values to notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-db-sidebar-migrate-"));
    const path = join(dir, "verne.db");
    const db = openDb(path);
    db.prepare("DELETE FROM app_state WHERE key = 'notes_rename_v1'").run();
    db.prepare(
      "INSERT INTO sidebar_state (scope_type, directory_id, active_tab_id, file_panel_active_id, right_sidebar_view) VALUES (?, ?, ?, ?, ?)"
    ).run("directory", "dir-1", "sc", "__scratchpads__", "scratchpads");
    openDb(path);
    const row = db.prepare(
      "SELECT file_panel_active_id, right_sidebar_view FROM sidebar_state WHERE directory_id = ?"
    ).get("dir-1") as { file_panel_active_id: string; right_sidebar_view: string };
    expect(row.file_panel_active_id).toBe("__notes__");
    expect(row.right_sidebar_view).toBe("notes");
  });

  it("display_title migration is additive and idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-conn-dt-"));
    const path = join(dir, "verne.db");
    const first = openDb(path);
    first.close();
    // Re-opening runs migrations again over the existing file.
    const db = openDb(path);
    const cols = (db.prepare("SELECT name FROM pragma_table_info('tabs')").all() as {
      name: string;
    }[]).map((r) => r.name);
    expect(cols.filter((n) => n === "display_title")).toHaveLength(1);
    db.close();
  });
});

describe("notes rename substr math", () => {
  it("maps scratchpad_ prefix to notes_ via substr(11)", () => {
    const key = "scratchpad_editor_prefs";
    expect("notes" + key.slice(10)).toBe("notes_editor_prefs");
  });
});
