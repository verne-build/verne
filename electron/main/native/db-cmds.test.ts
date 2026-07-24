import { describe, expect, it, vi } from "vitest";
import type { WorkingDirectory } from "../../../src/types/shared";
import { createWorktreeDirectory } from "./db-cmds";

const parent: WorkingDirectory = {
  id: "parent",
  path: "/repo",
  name: "repo",
  createdAt: 1,
  sortOrder: 0,
};

function createDeps(cleanupError?: Error) {
  const request = vi.fn(async (method: string) => {
    if (method === "worktree_create_git") {
      return { path: "/worktrees/feature", branch: "feature", repoRoot: "/repo" };
    }
    if (cleanupError) throw cleanupError;
    return true;
  });
  const dbError = new Error("directory insert failed");
  const insert = vi.fn(() => { throw dbError; });
  return { request, insert, dbError };
}

describe("createWorktreeDirectory", () => {
  it("removes the created worktree when the directory insert fails", async () => {
    const { request, insert, dbError } = createDeps();

    await expect(createWorktreeDirectory(
      { parentDirectoryId: parent.id, branch: "feature" },
      parent,
      null,
      { request, insert, makeId: () => "worktree", now: () => 2 },
    )).rejects.toBe(dbError);

    expect(insert).toHaveBeenCalledOnce();
    expect(request).toHaveBeenNthCalledWith(2, "worktree_remove_git", {
      parentPath: "/repo",
      dirPath: "/worktrees/feature",
      force: true,
    });
  });

  it("preserves the insert error and appends a compensation error", async () => {
    const { request, insert } = createDeps(new Error("remove failed"));

    await expect(createWorktreeDirectory(
      { parentDirectoryId: parent.id },
      parent,
      null,
      { request, insert, makeId: () => "worktree", now: () => 2 },
    )).rejects.toThrow("directory insert failed; worktree cleanup failed: remove failed");
  });
});
