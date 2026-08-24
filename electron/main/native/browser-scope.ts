import type { DatabaseSync } from "node:sqlite";
import type { BrowserTabScope } from "../../../src/types/shared";
import { getDirectories, getDirectory, resolveWorkspaceRoot } from "../db/directories";
import { getTab } from "../db/tabs";

export function resolveBrowserScope(
  db: DatabaseSync,
  workspaceDir: string,
  sourceTabId?: string,
): BrowserTabScope {
  if (sourceTabId) {
    const tab = getTab(db, sourceTabId);
    if (!tab) throw new Error(`browser source tab ${sourceTabId} not found`);
    const directory = getDirectory(db, tab.directoryId);
    if (!directory) throw new Error(`browser source directory ${tab.directoryId} not found`);
    const root = resolveWorkspaceRoot(db, directory.id);
    if (workspaceDir !== directory.path && workspaceDir !== root) {
      throw new Error(`browser source tab ${sourceTabId} is not in workspace ${workspaceDir}`);
    }
    return { path: directory.path, scopeType: "directory", scopeId: directory.id };
  }

  const directory = getDirectories(db).find((candidate) => candidate.path === workspaceDir);
  if (!directory) throw new Error(`browser workspace ${workspaceDir} not found`);
  return { path: directory.path, scopeType: "directory", scopeId: directory.id };
}
