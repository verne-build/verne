import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db/connection";
import { insertDirectory, getDirectory } from "./db/directories";
import { insertTab, getTab, setTabScopePinned } from "./db/tabs";
import { resolveScopeChange, handleSessionCwd, type PathClassification } from "./scope-repin";
import type { Tab, WorkingDirectory } from "../../src/types/shared";

const root = { id: "d1", path: "/repo", parentDirectoryId: undefined } as WorkingDirectory;
const wt = { id: "d2", path: "/wts/perf", repoRoot: "/repo", parentDirectoryId: "d1" } as WorkingDirectory;
const tab = { id: "t1", directoryId: "d1" } as Tab;

describe("resolveScopeChange", () => {
  it("cwd inside current scope → ignore (subdir cds never re-pin)", () => {
    expect(resolveScopeChange([root, wt], tab, "/repo/src/components", null)).toEqual({ action: "ignore" });
    expect(resolveScopeChange([root, wt], tab, "/repo", null)).toEqual({ action: "ignore" });
  });

  it("cwd inside another registered dir → move", () => {
    expect(resolveScopeChange([root, wt], tab, "/wts/perf/src", null)).toEqual({ action: "move", toDirectoryId: "d2" });
    expect(resolveScopeChange([root, wt], tab, "/wts/perf", null)).toEqual({ action: "move", toDirectoryId: "d2" });
  });

  it("prefix that is not a path boundary does not match", () => {
    expect(resolveScopeChange([root, wt], tab, "/wts/perf-2", null)).toEqual({ action: "ignore" });
    expect(resolveScopeChange([root, wt], { id: "t1", directoryId: "d2" } as Tab, "/repository", null)).toEqual({ action: "ignore" });
  });

  it("deepest registered dir wins (worktree over parent root)", () => {
    const nestedWt = { id: "d3", path: "/repo/wts/x", repoRoot: "/repo", parentDirectoryId: "d1" } as WorkingDirectory;
    const t = { id: "t1", directoryId: "d2" } as Tab;
    expect(resolveScopeChange([root, wt, nestedWt], t, "/repo/wts/x/src", null)).toEqual({ action: "move", toDirectoryId: "d3" });
  });

  it("unregistered linked worktree of a registered root → register-and-move", () => {
    const cls: PathClassification = { workdir: "/wts/new", commonWorkdir: "/repo", isLinkedWorktree: true, isBare: false };
    expect(resolveScopeChange([root, wt], tab, "/wts/new/src", cls)).toEqual({
      action: "register-and-move", workdir: "/wts/new", parentDirectoryId: "d1", repoRoot: "/repo",
    });
  });

  it("matches parent via repoRoot when parent path differs", () => {
    const rootWithRepo = { id: "d1", path: "/repo-checkout", repoRoot: "/repo", parentDirectoryId: undefined } as WorkingDirectory;
    const cls: PathClassification = { workdir: "/wts/new", commonWorkdir: "/repo", isLinkedWorktree: true, isBare: false };
    expect(resolveScopeChange([rootWithRepo], tab, "/wts/new", cls)).toEqual({
      action: "register-and-move", workdir: "/wts/new", parentDirectoryId: "d1", repoRoot: "/repo",
    });
  });

  it("nested/unrelated/bare → ignore", () => {
    expect(resolveScopeChange([root, wt], tab, "/elsewhere", null)).toEqual({ action: "ignore" });
    expect(resolveScopeChange([root, wt], tab, "/elsewhere", { workdir: "/other", commonWorkdir: "/other", isLinkedWorktree: false, isBare: false })).toEqual({ action: "ignore" });
    expect(resolveScopeChange([root, wt], tab, "/elsewhere", { workdir: null, commonWorkdir: null, isLinkedWorktree: false, isBare: true })).toEqual({ action: "ignore" });
  });

  it("linked worktree whose main repo is unregistered → ignore", () => {
    const cls: PathClassification = { workdir: "/wts/new", commonWorkdir: "/other-repo", isLinkedWorktree: true, isBare: false };
    expect(resolveScopeChange([root, wt], tab, "/wts/new", cls)).toEqual({ action: "ignore" });
  });
});

// ---- handleSessionCwd orchestration ----

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "verne-repin-")));
  const repo = join(base, "repo");
  const wtPerf = join(base, "wts", "perf");
  const wtNew = join(base, "wts", "new");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(wtPerf, "src"), { recursive: true });
  mkdirSync(join(wtNew, "src"), { recursive: true });
  const db = openDb(join(base, "verne.db"));
  insertDirectory(db, { id: "d1", path: repo, name: "repo", createdAt: 0, sortOrder: 0 });
  insertDirectory(db, { id: "d2", path: wtPerf, name: "perf", repoRoot: repo, createdAt: 0, sortOrder: 1, parentDirectoryId: "d1" });
  insertTab(db, { id: "t1", directoryId: "d1", label: "1", cwd: repo, sortOrder: 0, createdAt: 0, userRenamed: false });
  insertTab(db, { id: "t2", directoryId: "d2", label: "1", cwd: wtPerf, sortOrder: 0, createdAt: 0, userRenamed: false });
  const broadcasts: Array<[string, unknown]> = [];
  const deps = (classify: PathClassification | null = null) => ({
    db,
    sidecarRequest: vi.fn(async (method: string) => {
      if (method === "classify_path") return classify as never;
      return null as never;
    }),
    broadcast: (n: string, p: unknown) => broadcasts.push([n, p]),
  });
  return { db, repo, wtPerf, wtNew, broadcasts, deps };
}

describe("handleSessionCwd", () => {
  it("no-op for unknown tab / pinned tab / vanished cwd", async () => {
    const { db, repo, wtPerf, broadcasts, deps } = setup();
    await handleSessionCwd({ tabId: "nope", cwd: wtPerf }, deps());
    setTabScopePinned(db, "t1", true);
    await handleSessionCwd({ tabId: "t1", cwd: wtPerf }, deps());
    setTabScopePinned(db, "t1", false);
    await handleSessionCwd({ tabId: "t1", cwd: join(repo, "does-not-exist") }, deps());
    expect(broadcasts).toEqual([]);
    expect(getTab(db, "t1")!.directoryId).toBe("d1");
  });

  it("cwd inside current scope → no change", async () => {
    const { db, repo, broadcasts, deps } = setup();
    await handleSessionCwd({ tabId: "t1", cwd: join(repo, "src") }, deps());
    expect(broadcasts).toEqual([]);
    expect(getTab(db, "t1")!.cwd).toBe(repo);
  });

  it("cwd inside another registered dir → moves + shadow reset + broadcast", async () => {
    const { db, wtPerf, broadcasts, deps } = setup();
    const d = deps();
    await handleSessionCwd({ tabId: "t1", cwd: join(wtPerf, "src") }, d);
    const t1 = getTab(db, "t1")!;
    expect(t1.directoryId).toBe("d2");
    expect(t1.cwd).toBe(join(wtPerf, "src"));
    expect(t1.sortOrder).toBe(1); // appended after t2
    expect(d.sidecarRequest).toHaveBeenCalledWith("agent_shadow_cleanup", { tabId: "t1" });
    expect(broadcasts).toEqual([
      ["session-scope-changed", { tabId: "t1", fromDirectoryId: "d1", toDirectoryId: "d2", cwd: join(wtPerf, "src") }],
    ]);
  });

  it("unregistered linked worktree → registers dir, backfills repo_root, moves, broadcasts in order", async () => {
    const { db, repo, wtNew, broadcasts, deps } = setup();
    const d = deps({ workdir: wtNew, commonWorkdir: repo, isLinkedWorktree: true, isBare: false });
    await handleSessionCwd({ tabId: "t1", cwd: join(wtNew, "src") }, d);
    const t1 = getTab(db, "t1")!;
    expect(t1.directoryId).not.toBe("d1");
    expect(t1.cwd).toBe(join(wtNew, "src"));
    const added = getDirectory(db, t1.directoryId)!;
    expect(added.path).toBe(wtNew);
    expect(added.name).toBe("new");
    expect(added.repoRoot).toBe(repo);
    expect(added.parentDirectoryId).toBe("d1");
    expect(getDirectory(db, "d1")!.repoRoot).toBe(repo); // backfilled
    expect(broadcasts.map(([n]) => n)).toEqual(["directory-added", "session-scope-changed"]);
    expect(broadcasts[0][1]).toEqual({ directory: added });
    expect(broadcasts[1][1]).toEqual({ tabId: "t1", fromDirectoryId: "d1", toDirectoryId: added.id, cwd: join(wtNew, "src") });
  });

  it("unregistered non-worktree path → ignore even after classify", async () => {
    const { db, wtNew, broadcasts, deps } = setup();
    const d = deps({ workdir: wtNew, commonWorkdir: wtNew, isLinkedWorktree: false, isBare: false });
    await handleSessionCwd({ tabId: "t1", cwd: wtNew }, d);
    expect(broadcasts).toEqual([]);
    expect(getTab(db, "t1")!.directoryId).toBe("d1");
  });
});
