/**
 * Scope re-pin: react to daemon `session-cwd` events by moving a tab to the
 * working directory (scope) that now contains its cwd. Re-pin happens ONLY at
 * repo/worktree granularity — subdir cds inside the current scope never move.
 * `scope_pinned_by_user` suppresses all auto re-pinning.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Tab, WorkingDirectory } from "../../src/types/shared";
import {
  getTab,
  getTabScopePinned,
  moveTabToDirectory,
  moveTabInsideOpenTxn,
} from "./db/tabs";
import { getDirectories, insertDirectory } from "./db/directories";

/** Shape of the sidecar `classify_path` result (services/git.rs, camelCase serde). */
export interface PathClassification {
  workdir: string | null;
  commonWorkdir: string | null;
  isLinkedWorktree: boolean;
  isBare: boolean;
}

export type ScopeChange =
  | { action: "ignore" }
  | { action: "move"; toDirectoryId: string }
  | { action: "register-and-move"; workdir: string; parentDirectoryId: string; repoRoot: string };

const inside = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/** Pure decision: where (if anywhere) should this tab live given its new cwd. */
export function resolveScopeChange(
  dirs: WorkingDirectory[],
  tab: Tab,
  canonicalCwd: string,
  classification: PathClassification | null,
): ScopeChange {
  const current = dirs.find((d) => d.id === tab.directoryId);
  if (current && inside(canonicalCwd, current.path)) return { action: "ignore" };
  // Deepest registered dir containing the cwd wins (worktree over its parent root).
  const hit = dirs
    .filter((d) => inside(canonicalCwd, d.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (hit) return { action: "move", toDirectoryId: hit.id };
  // Unregistered: only auto-register a linked worktree of a registered root's repo.
  if (!classification || classification.isBare || !classification.isLinkedWorktree)
    return { action: "ignore" };
  const { workdir, commonWorkdir } = classification;
  if (!workdir || !commonWorkdir) return { action: "ignore" };
  const parent = dirs.find(
    (d) => !d.parentDirectoryId && (d.path === commonWorkdir || d.repoRoot === commonWorkdir),
  );
  if (!parent) return { action: "ignore" };
  return { action: "register-and-move", workdir, parentDirectoryId: parent.id, repoRoot: commonWorkdir };
}

export interface SessionCwdDeps {
  db: DatabaseSync;
  sidecarRequest: <T>(method: string, params: unknown) => Promise<T>;
  broadcast: (name: string, payload: unknown) => void;
}

/** Orchestrate one session-cwd event: resolve, persist (one txn), reset shadow, broadcast. */
export async function handleSessionCwd(
  ev: { tabId: string; cwd: string },
  deps: SessionCwdDeps,
): Promise<void> {
  const { db, sidecarRequest, broadcast } = deps;
  const tab = getTab(db, ev.tabId);
  if (!tab || getTabScopePinned(db, ev.tabId)) return;
  let canonical: string;
  try {
    canonical = await fs.promises.realpath(ev.cwd); // symlinks resolved (spec)
  } catch {
    return; // cwd vanished
  }
  const dirs = getDirectories(db);
  let change = resolveScopeChange(dirs, tab, canonical, null);
  if (change.action === "ignore") {
    const cls = await sidecarRequest<PathClassification | null>("classify_path", {
      path: canonical,
    }).catch(() => null);
    change = resolveScopeChange(dirs, tab, canonical, cls);
  }
  if (change.action === "ignore") return;

  let toDirectoryId: string;
  let addedDirectory: WorkingDirectory | undefined;
  if (change.action === "register-and-move") {
    // Attach-only registration (no `git worktree add`) + move, one transaction.
    const parent = dirs.find((d) => d.id === change.parentDirectoryId)!;
    addedDirectory = {
      id: randomUUID(),
      path: change.workdir,
      name: path.basename(change.workdir),
      repoRoot: change.repoRoot,
      createdAt: Date.now(),
      sortOrder: parent.sortOrder + 1,
      parentDirectoryId: parent.id,
    };
    db.exec("BEGIN");
    try {
      insertDirectory(db, addedDirectory);
      // repo_root backfill on the parent while we know it (spec)
      if (!parent.repoRoot)
        db.prepare("UPDATE directories SET repo_root = ? WHERE id = ?").run(change.repoRoot, parent.id);
      moveTabInsideOpenTxn(db, ev.tabId, addedDirectory.id, canonical);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    toDirectoryId = addedDirectory.id;
  } else {
    toDirectoryId = change.toDirectoryId;
    moveTabToDirectory(db, ev.tabId, toDirectoryId, canonical);
  }

  // Shadow reset: relative-path baselines collide across worktrees (spec).
  void sidecarRequest("agent_shadow_cleanup", { tabId: ev.tabId }).catch(() => {});

  if (addedDirectory) broadcast("directory-added", { directory: addedDirectory }); // order fixed by spec
  broadcast("session-scope-changed", {
    tabId: ev.tabId,
    fromDirectoryId: tab.directoryId,
    toDirectoryId,
    cwd: canonical,
  });
}
