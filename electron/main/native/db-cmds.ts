/**
 * Native handlers for non-tab DB RPCs — shadow the sidecar.
 * ipc-router checks native handlers first, so these intercept before the socket.
 */
import { BrowserWindow } from "electron";
import type { DaemonClient } from "../daemon-client";
import type { WorkingDirectory } from "../../../src/types/shared";
import { randomUUID } from "node:crypto";
import { registerNative } from "../ipc-router";
import { getDb } from "../db/connection";
import {
  getDirectories,
  getDirectory,
  createDirectory,
  insertDirectory,
  deleteDirectory,
  renameDirectory,
  reorderDirectories,
  resolveWorkspaceRoot,
  getDirectorySettings,
  setDirectorySettings,
} from "../db/directories";
import { getAppState, setAppState } from "../db/appState";
import { getEditorTabs, saveEditorTabs } from "../db/editorTabs";
import {
  addFavorite,
  removeFavorite,
  getFavorites,
  recordHistory,
  getHistory,
  clearHistory,
  renameFavorite,
  removeHistory,
} from "../db/browser";
import { getSidebarTabs, saveSidebarTabs, getSidebarState } from "../db/sidebar";
import {
  getGroups,
  createGroup,
  updateGroupLayout,
  setGroupActivePane,
  reorderGroups,
  deleteGroup,
} from "../db/groups";

function broadcast(win: BrowserWindow, name: string, payload: unknown): void {
  win.webContents.send("daemon-event", name, payload);
}

export function registerDbCommands(
  getWindow: () => BrowserWindow,
  getSidecar: () => DaemonClient | null,
): void {
  // ---- directories ----
  registerNative("get_directories", () => {
    return getDirectories(getDb());
  });

  registerNative("create_directory", (p: { path: string }, win) => {
    const dir = createDirectory(getDb(), p.path);
    broadcast(win, "directory-added", { directory: dir });
    return dir;
  });

  registerNative("delete_directory", (p: { id: string }, win) => {
    // Snapshot before delete so the sidecar can walk the worktree subtree.
    const allDirs = getDirectories(getDb());
    deleteDirectory(getDb(), p.id);
    broadcast(win, "directory-deleted", { id: p.id });
    // Sidecar still owns the dir's watchers/shadow trees/file caches — tell it to
    // tear them down (fire-and-forget; pass the pre-delete snapshot, no DB read).
    getSidecar()?.request("evict_directory_resources", { id: p.id, allDirs }).catch(() => {});
    return true;
  });

  registerNative("rename_directory", (p: { id: string; name: string }, win) => {
    const dir = renameDirectory(getDb(), p.id, p.name);
    if (dir) broadcast(win, "directory-updated", { directory: dir });
    return dir;
  });

  registerNative("reorder_directories", (p: { ids: string[] }, win) => {
    reorderDirectories(getDb(), p.ids);
    broadcast(win, "directories-reordered", { ids: p.ids });
    return true;
  });

  // ---- worktrees (git2 in sidecar; rows owned here) ----
  registerNative("worktree_create", async (p: { parentDirectoryId: string; branch: string }, win) => {
    const db = getDb();
    const parent = getDirectory(db, p.parentDirectoryId);
    if (!parent) throw new Error("parent directory not found");
    const settings = getDirectorySettings(db, p.parentDirectoryId);
    const r = (await getSidecar()!.request("worktree_create_git", {
      parentPath: parent.path,
      parentDirectoryId: p.parentDirectoryId,
      branch: p.branch,
      defaultBaseRef: settings?.defaultBaseRef ?? null,
    })) as { path: string; branch: string; repoRoot: string };
    const dir: WorkingDirectory = {
      id: randomUUID(),
      path: r.path,
      name: r.branch,
      repoRoot: r.repoRoot,
      createdAt: Date.now(),
      sortOrder: parent.sortOrder + 1,
      parentDirectoryId: p.parentDirectoryId,
    };
    insertDirectory(db, dir);
    broadcast(win, "directory-added", { directory: dir });
    return dir;
  });

  registerNative("worktree_remove", async (p: { id: string; force?: boolean }, win) => {
    const db = getDb();
    const dir = getDirectory(db, p.id);
    if (!dir) throw new Error("directory not found");
    if (!dir.parentDirectoryId) throw new Error("not a worktree workspace");
    const parent = getDirectory(db, dir.parentDirectoryId);
    if (!parent) throw new Error("parent directory missing");
    const allDirs = getDirectories(db);
    await getSidecar()!.request("worktree_remove_git", {
      parentPath: parent.path,
      dirPath: dir.path,
      force: p.force ?? false,
    });
    deleteDirectory(db, p.id);
    broadcast(win, "directory-deleted", { id: p.id });
    getSidecar()!.request("evict_directory_resources", { id: p.id, allDirs }).catch(() => {});
    return true;
  });

  registerNative("worktree_rename", async (p: { id: string; branch: string }, win) => {
    const db = getDb();
    const dir = getDirectory(db, p.id);
    if (!dir) throw new Error("directory not found");
    if (!dir.parentDirectoryId) throw new Error("not a worktree workspace");
    const parent = getDirectory(db, dir.parentDirectoryId);
    if (!parent) throw new Error("parent directory missing");
    const res = (await getSidecar()!.request("worktree_rename_git", {
      parentPath: parent.path,
      dirPath: dir.path,
      branch: p.branch,
    })) as { branch: string };
    const updated = renameDirectory(db, p.id, res.branch);
    if (updated) broadcast(win, "directory-updated", { directory: updated });
    return updated;
  });

  registerNative("set_active_directory", (p: { directoryId?: string }) => {
    setAppState(getDb(), "lastActiveDirectoryId", p.directoryId ?? null);
    return true;
  });

  registerNative("get_directory_settings", (p: { directoryId: string }) => {
    return getDirectorySettings(getDb(), p.directoryId);
  });

  registerNative("update_directory_settings", (p: { directoryId: string; partial: Record<string, unknown> }) => {
    const db = getDb();
    const current = getDirectorySettings(db, p.directoryId);
    // Merge: null values remove keys; others set them
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(p.partial ?? {})) {
      if (v === null || v === undefined) {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    }
    setDirectorySettings(db, p.directoryId, merged as { defaultBaseRef?: string });
    return merged;
  });

  // ---- app_state ----
  registerNative("get_app_state", (p: { key: string }) => {
    return getAppState(getDb(), p.key);
  });

  registerNative("set_app_state", (p: { key: string; value?: string }) => {
    setAppState(getDb(), p.key, p.value ?? null);
    return true;
  });

  // ---- editor tabs (open_tabs) ----
  registerNative("get_tabs", (p: { scopeType: string; scopeId: string }) => {
    return getEditorTabs(getDb(), p.scopeType, p.scopeId);
  });

  registerNative("save_tabs", (p: { scopeType: string; scopeId: string; tabState: Parameters<typeof saveEditorTabs>[3] }) => {
    saveEditorTabs(getDb(), p.scopeType, p.scopeId, p.tabState);
    return true;
  });

  // ---- sidebar ----
  registerNative("get_sidebar_tabs", (p: { directoryId: string; scopeType?: string }) => {
    const scope = p.scopeType ?? "directory";
    return getSidebarTabs(getDb(), scope, p.directoryId);
  });

  registerNative("save_sidebar_tabs", (p: {
    directoryId: string;
    scopeType?: string;
    tabs: Parameters<typeof saveSidebarTabs>[3];
    activeTabId: string;
    listColumnWidth: number;
    rightSidebarView?: string;
    filePanelActiveId?: string;
  }) => {
    const scope = p.scopeType ?? "directory";
    saveSidebarTabs(
      getDb(), scope, p.directoryId,
      p.tabs, p.activeTabId,
      p.listColumnWidth ?? 0,
      p.rightSidebarView ?? null,
      p.filePanelActiveId ?? null,
    );
    return true;
  });

  registerNative("get_sidebar_state", (p: { directoryId: string; scopeType?: string }) => {
    const scope = p.scopeType ?? "directory";
    return getSidebarState(getDb(), scope, p.directoryId);
  });

  // ---- tab groups ----
  registerNative("groups_list", (p: { directoryId?: string | null }) => {
    return getGroups(getDb(), p.directoryId);
  });

  registerNative("group_create", (p: { directoryId: string; layout: string; activePaneId?: string }) => {
    return createGroup(getDb(), p.directoryId, p.layout, p.activePaneId);
  });

  registerNative("group_update_layout", (p: { id: string; layout: string; activePaneId?: string }) => {
    updateGroupLayout(getDb(), p.id, p.layout, p.activePaneId);
    return true;
  });

  registerNative("group_set_active_pane", (p: { id: string; paneId: string }) => {
    setGroupActivePane(getDb(), p.id, p.paneId);
    return true;
  });

  registerNative("groups_reorder", (p: { ids: string[] }) => {
    reorderGroups(getDb(), p.ids);
    return true;
  });

  registerNative("group_delete", (p: { id: string }) => {
    deleteGroup(getDb(), p.id);
    return true;
  });

  // ---- recent files (frecency now native to FFF in the sidecar) ----
  registerNative("touch_recent_file", (p: { directoryId: string; path: string; scopeType?: string }) => {
    return getSidecar()!.request("touch_recent_file", { path: p.path });
  });

  // ---- notes (workspace root resolved here, no sidecar DB) ----
  registerNative("notes_dir_path", (p: { directoryId: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    return getSidecar()!.request("notes_dir_path", { workspaceRoot: root });
  });

  registerNative("notes_list", (p: { directoryId: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    return getSidecar()!.request("notes_list", { workspaceRoot: root });
  });

  registerNative("notes_create", (p: { directoryId: string; title: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    return getSidecar()!.request("notes_create", { workspaceRoot: root, title: p.title });
  });

  registerNative("notes_rename", (p: { directoryId: string; slug: string; title: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    return getSidecar()!.request("notes_rename", {
      workspaceRoot: root,
      slug: p.slug,
      title: p.title,
    });
  });

  registerNative("notes_delete", (p: { directoryId: string; slug: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    return getSidecar()!.request("notes_delete", { workspaceRoot: root, slug: p.slug });
  });

  // ---- browser favorites & history ----
  registerNative("browser_favorites_list", (p: { directoryId: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    return getFavorites(getDb(), root);
  });

  registerNative("browser_favorite_add", (p: { directoryId: string; url: string; title: string; faviconUrl?: string | null }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    addFavorite(getDb(), root, p.url, p.title, p.faviconUrl ?? null);
    return true;
  });

  registerNative("browser_favorite_remove", (p: { directoryId: string; url: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    removeFavorite(getDb(), root, p.url);
    return true;
  });

  registerNative("browser_history_list", (p: { directoryId: string; limit?: number }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    return getHistory(getDb(), root, p.limit ?? 500);
  });

  registerNative("browser_history_record", (p: { directoryId: string; url: string; title: string; faviconUrl?: string | null }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) return true; // no active workspace yet — silently skip
    recordHistory(getDb(), root, p.url, p.title, p.faviconUrl ?? null);
    return true;
  });

  registerNative("browser_history_clear", (p: { directoryId: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    clearHistory(getDb(), root);
    return true;
  });

  registerNative("browser_favorite_rename", (p: { directoryId: string; url: string; title: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    renameFavorite(getDb(), root, p.url, p.title);
    return true;
  });

  registerNative("browser_history_remove", (p: { directoryId: string; url: string }) => {
    const root = resolveWorkspaceRoot(getDb(), p.directoryId);
    if (!root) throw new Error("directory not found");
    removeHistory(getDb(), root, p.url);
    return true;
  });

  // ---- file search (FFF fuzzy + native frecency in the sidecar) ----
  registerNative("search_files", (p: { dir: string; query: string }) => {
    return getSidecar()!.request("search_files", { dir: p.dir, query: p.query });
  });

  // Suppress unused warning — getWindow is available for future event emissions
  void getWindow;
}
