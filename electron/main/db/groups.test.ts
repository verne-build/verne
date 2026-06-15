import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import {
  createGroup,
  deleteGroup,
  getGroups,
  insertGroup,
  nextGroupSortOrder,
  reorderGroups,
  setGroupActivePane,
  updateGroupLayout,
} from "./groups";
import { insertDirectory } from "./directories";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-groups-"));
  return openDb(join(dir, "verne.db"));
}

function seedDir(db: ReturnType<typeof tmpDb>, id = "dir-1") {
  insertDirectory(db, { id, path: `/tmp/${id}`, name: id, createdAt: 0, sortOrder: 0 });
}

describe("groups", () => {
  it("getGroups returns empty for unknown dir", () => {
    const db = tmpDb();
    expect(getGroups(db, "dir-1")).toEqual([]);
  });

  it("createGroup inserts and returns group", () => {
    const db = tmpDb();
    seedDir(db);
    const g = createGroup(db, "dir-1", '{"pane":"t1"}', "t1");
    expect(g.id).toBeTruthy();
    expect(g.directoryId).toBe("dir-1");
    expect(g.layout).toBe('{"pane":"t1"}');
    expect(g.activePaneId).toBe("t1");
    expect(g.sortOrder).toBe(0);
  });

  it("nextGroupSortOrder increments", () => {
    const db = tmpDb();
    seedDir(db);
    expect(nextGroupSortOrder(db, "dir-1")).toBe(0);
    createGroup(db, "dir-1", '{"pane":"t1"}');
    expect(nextGroupSortOrder(db, "dir-1")).toBe(1);
    createGroup(db, "dir-1", '{"pane":"t2"}');
    expect(nextGroupSortOrder(db, "dir-1")).toBe(2);
  });

  it("insertGroup + getGroups round-trip", () => {
    const db = tmpDb();
    seedDir(db);
    const g = createGroup(db, "dir-1", '{"pane":"t1"}');
    const groups = getGroups(db, "dir-1");
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(g.id);
  });

  it("getGroups without directoryId returns all", () => {
    const db = tmpDb();
    seedDir(db, "dir-1");
    seedDir(db, "dir-2");
    createGroup(db, "dir-1", '{"pane":"t1"}');
    createGroup(db, "dir-2", '{"pane":"t2"}');
    expect(getGroups(db)).toHaveLength(2);
  });

  it("updateGroupLayout changes layout and activePaneId", () => {
    const db = tmpDb();
    seedDir(db);
    const g = createGroup(db, "dir-1", '{"pane":"t1"}', "t1");
    updateGroupLayout(db, g.id, '{"pane":"t2"}', "t2");
    const updated = getGroups(db, "dir-1")[0];
    expect(updated.layout).toBe('{"pane":"t2"}');
    expect(updated.activePaneId).toBe("t2");
  });

  it("setGroupActivePane changes activePaneId", () => {
    const db = tmpDb();
    seedDir(db);
    const g = createGroup(db, "dir-1", '{"pane":"t1"}', "t1");
    setGroupActivePane(db, g.id, "t2");
    expect(getGroups(db, "dir-1")[0].activePaneId).toBe("t2");
  });

  it("reorderGroups sets sort_order", () => {
    const db = tmpDb();
    seedDir(db);
    const a = createGroup(db, "dir-1", '{"pane":"t1"}');
    const b = createGroup(db, "dir-1", '{"pane":"t2"}');
    reorderGroups(db, [b.id, a.id]);
    const groups = getGroups(db, "dir-1");
    expect(groups[0].id).toBe(b.id);
    expect(groups[1].id).toBe(a.id);
  });

  it("deleteGroup removes row", () => {
    const db = tmpDb();
    seedDir(db);
    const g = createGroup(db, "dir-1", '{"pane":"t1"}');
    deleteGroup(db, g.id);
    expect(getGroups(db, "dir-1")).toHaveLength(0);
  });
});
