import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connection";
import { insertDirectory } from "../db/directories";
import { insertTab } from "../db/tabs";
import { resolveBrowserScope } from "./browser-scope";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "verne-browser-scope-"));
  const db = openDb(join(dir, "verne.db"));
  insertDirectory(db, {
    id: "root", path: "/repo", name: "repo", createdAt: 1, sortOrder: 0,
  });
  insertDirectory(db, {
    id: "worktree", path: "/worktrees/feature", name: "feature", createdAt: 2,
    sortOrder: 1, parentDirectoryId: "root", repoRoot: "/repo",
  });
  insertTab(db, {
    id: "terminal:worktree", directoryId: "worktree", label: "1",
    cwd: "/worktrees/feature", sortOrder: 0, createdAt: 3, userRenamed: false,
  });
  return db;
}

describe("browser scope resolution", () => {
  it("uses the source terminal row to route a root-scoped MCP process to its worktree", () => {
    const db = fixture();

    expect(resolveBrowserScope(db, "/repo", "terminal:worktree")).toEqual({
      path: "/worktrees/feature",
      scopeType: "directory",
      scopeId: "worktree",
    });
    db.close();
  });

  it("resolves a source-less request only from an exact stored directory path", () => {
    const db = fixture();

    expect(resolveBrowserScope(db, "/repo")).toEqual({
      path: "/repo", scopeType: "directory", scopeId: "root",
    });
    expect(() => resolveBrowserScope(db, "/unknown")).toThrow(/not found/);
    db.close();
  });

  it("does not fall back to a root path when an explicit source tab is stale", () => {
    const db = fixture();

    expect(() => resolveBrowserScope(db, "/repo", "terminal:gone")).toThrow(/source tab/);
    db.close();
  });
});
