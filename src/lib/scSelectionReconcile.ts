import type { GitStatus, GitFileEntry } from "@/types";

/**
 * Whether the file backing an open Source Control diff selection still has a
 * change matching the selection's staged state. Used to auto-close a diff whose
 * file was committed/discarded — including via external git ops (agent commits
 * in a terminal) that only surface as a git-status refresh, with no in-app
 * `close-git-diff` dispatch.
 *
 * `null` status (e.g. transient git_status error) → keep the selection.
 */
export function scSelectionStillChanged(
  status: GitStatus | null,
  relPath: string,
  staged: boolean,
): boolean {
  if (!status) return true;
  const has = (list: GitFileEntry[]) => list.some((e) => e.path === relPath);
  return staged ? has(status.staged) : has(status.unstaged) || has(status.untracked);
}
