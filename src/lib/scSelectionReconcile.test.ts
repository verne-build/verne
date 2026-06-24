import { describe, it, expect } from "vitest";
import { scSelectionStillChanged } from "./scSelectionReconcile";
import type { GitStatus, GitFileEntry } from "@/types";

const entry = (path: string): GitFileEntry => ({
  path,
  status: "M",
  added: 1,
  deleted: 0,
  isBinary: false,
});

const status = (s: Partial<GitStatus>): GitStatus => ({
  staged: [],
  unstaged: [],
  untracked: [],
  ...s,
});

describe("scSelectionStillChanged", () => {
  it("keeps the selection when status is null (transient error)", () => {
    expect(scSelectionStillChanged(null, "a.ts", false)).toBe(true);
    expect(scSelectionStillChanged(null, "a.ts", true)).toBe(true);
  });

  it("keeps a staged selection while the file is still staged", () => {
    expect(scSelectionStillChanged(status({ staged: [entry("a.ts")] }), "a.ts", true)).toBe(true);
  });

  it("drops a staged selection once committed (gone from staged)", () => {
    expect(scSelectionStillChanged(status({}), "a.ts", true)).toBe(false);
  });

  it("drops a staged selection that now only has worktree changes", () => {
    expect(
      scSelectionStillChanged(status({ unstaged: [entry("a.ts")] }), "a.ts", true),
    ).toBe(false);
  });

  it("keeps an unstaged selection while the file is unstaged", () => {
    expect(
      scSelectionStillChanged(status({ unstaged: [entry("a.ts")] }), "a.ts", false),
    ).toBe(true);
  });

  it("keeps an unstaged selection for an untracked file", () => {
    expect(
      scSelectionStillChanged(status({ untracked: [entry("a.ts")] }), "a.ts", false),
    ).toBe(true);
  });

  it("drops an unstaged selection once the file is committed/discarded", () => {
    expect(scSelectionStillChanged(status({}), "a.ts", false)).toBe(false);
  });
});
