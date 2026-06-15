import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import { touchRecentFile, getRecentFiles } from "./recentFiles";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-recent-"));
  return openDb(join(dir, "verne.db"));
}

describe("recentFiles", () => {
  it("returns empty array when none exist", () => {
    const db = tmpDb();
    expect(getRecentFiles(db, "directory", "dir-1")).toEqual([]);
  });

  it("touch + get returns path", () => {
    const db = tmpDb();
    touchRecentFile(db, "directory", "dir-1", "/src/index.ts");
    const files = getRecentFiles(db, "directory", "dir-1");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/src/index.ts");
    expect(typeof files[0].openedAt).toBe("number");
  });

  it("touch updates openedAt on duplicate", () => {
    const db = tmpDb();
    touchRecentFile(db, "directory", "dir-1", "/a.ts");
    const before = getRecentFiles(db, "directory", "dir-1")[0].openedAt;
    touchRecentFile(db, "directory", "dir-1", "/a.ts");
    const after = getRecentFiles(db, "directory", "dir-1")[0].openedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("returns most recent first", () => {
    const db = tmpDb();
    // Insert with explicit timestamps to guarantee ordering
    db.prepare(
      "INSERT OR REPLACE INTO recent_files (scope_type, directory_id, path, opened_at) VALUES (?, ?, ?, ?)"
    ).run("directory", "dir-1", "/a.ts", 1000);
    db.prepare(
      "INSERT OR REPLACE INTO recent_files (scope_type, directory_id, path, opened_at) VALUES (?, ?, ?, ?)"
    ).run("directory", "dir-1", "/b.ts", 2000);
    const files = getRecentFiles(db, "directory", "dir-1");
    expect(files[0].path).toBe("/b.ts");
    expect(files[1].path).toBe("/a.ts");
  });

  it("scopes by scopeType + scopeId", () => {
    const db = tmpDb();
    touchRecentFile(db, "directory", "dir-1", "/a.ts");
    expect(getRecentFiles(db, "directory", "dir-2")).toHaveLength(0);
    expect(getRecentFiles(db, "agent_worktree", "dir-1")).toHaveLength(0);
  });
});
