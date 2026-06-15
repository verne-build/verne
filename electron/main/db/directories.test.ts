import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import {
  createDirectory,
  deleteDirectory,
  getDirectories,
  getDirectory,
  getDirectorySettings,
  insertDirectory,
  renameDirectory,
  reorderDirectories,
  resolveWorkspaceRoot,
  setDirectorySettings,
} from "./directories";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-dirs-"));
  return openDb(join(dir, "verne.db"));
}

describe("directories", () => {
  it("createDirectory inserts and returns a row", () => {
    const db = tmpDb();
    const d = createDirectory(db, "/tmp/myrepo");
    expect(d.id).toBeTruthy();
    expect(d.path).toBe("/tmp/myrepo");
    expect(d.name).toBe("myrepo");
    expect(d.sortOrder).toBe(1);
  });

  it("createDirectory is idempotent (returns same id on duplicate path)", () => {
    const db = tmpDb();
    const a = createDirectory(db, "/tmp/myrepo");
    const b = createDirectory(db, "/tmp/myrepo");
    expect(a.id).toBe(b.id);
  });

  it("getDirectories returns all ordered", () => {
    const db = tmpDb();
    createDirectory(db, "/tmp/a");
    createDirectory(db, "/tmp/b");
    const dirs = getDirectories(db);
    expect(dirs.length).toBe(2);
    expect(dirs[0].path).toBe("/tmp/a");
    expect(dirs[1].path).toBe("/tmp/b");
  });

  it("getDirectory returns null for unknown id", () => {
    const db = tmpDb();
    expect(getDirectory(db, "nope")).toBeNull();
  });

  it("insertDirectory inserts with full fields", () => {
    const db = tmpDb();
    insertDirectory(db, {
      id: "d1",
      path: "/tmp/d1",
      name: "d1",
      createdAt: 1000,
      sortOrder: 0,
    });
    const got = getDirectory(db, "d1");
    expect(got?.id).toBe("d1");
    expect(got?.path).toBe("/tmp/d1");
  });

  it("deleteDirectory removes row and returns true", () => {
    const db = tmpDb();
    const d = createDirectory(db, "/tmp/todelete");
    expect(deleteDirectory(db, d.id)).toBe(true);
    expect(getDirectory(db, d.id)).toBeNull();
  });

  it("deleteDirectory returns false for unknown id", () => {
    const db = tmpDb();
    expect(deleteDirectory(db, "nope")).toBe(false);
  });

  it("renameDirectory updates name", () => {
    const db = tmpDb();
    const d = createDirectory(db, "/tmp/orig");
    const renamed = renameDirectory(db, d.id, "newname");
    expect(renamed?.name).toBe("newname");
  });

  it("renameDirectory returns null for unknown id", () => {
    const db = tmpDb();
    expect(renameDirectory(db, "nope", "x")).toBeNull();
  });

  it("reorderDirectories sets sort_order", () => {
    const db = tmpDb();
    const a = createDirectory(db, "/tmp/a2");
    const b = createDirectory(db, "/tmp/b2");
    reorderDirectories(db, [b.id, a.id]);
    const dirs = getDirectories(db);
    expect(dirs[0].id).toBe(b.id);
    expect(dirs[1].id).toBe(a.id);
  });

  it("resolveWorkspaceRoot walks parent chain", () => {
    const db = tmpDb();
    insertDirectory(db, { id: "root", path: "/tmp/root", name: "root", createdAt: 0, sortOrder: 0 });
    insertDirectory(db, {
      id: "child",
      path: "/tmp/root/worktree",
      name: "worktree",
      createdAt: 0,
      sortOrder: 0,
      parentDirectoryId: "root",
    });
    expect(resolveWorkspaceRoot(db, "child")).toBe("/tmp/root");
    expect(resolveWorkspaceRoot(db, "root")).toBe("/tmp/root");
  });

  it("resolveWorkspaceRoot returns null for unknown id", () => {
    const db = tmpDb();
    expect(resolveWorkspaceRoot(db, "nope")).toBeNull();
  });

  it("directory settings round-trip", () => {
    const db = tmpDb();
    // Ensure settings_json column exists (it's added in migration on existing DBs)
    const d = createDirectory(db, "/tmp/settingstest");
    const s = getDirectorySettings(db, d.id);
    expect(s).toEqual({});
    setDirectorySettings(db, d.id, { defaultBaseRef: "main" });
    const s2 = getDirectorySettings(db, d.id);
    expect(s2.defaultBaseRef).toBe("main");
  });
});
