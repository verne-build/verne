import { invoke, listen, type UnlistenFn } from "@/platform";
import type { Shortcut } from "@/lib/shortcuts/types";
import type {
  DirectorySettings,
  WorkingDirectory,
  ResourceUsage,
  DebugMetrics,
  AppSettings,
  StoredTabState,
  GitStatus,
  GitDiffResult,
  GitCommitLogResult,
  GitCommitFileEntry,
  GitBranch,
  SidebarTabRow,
  SidebarState,
  TabUpdatedEvent,
  TabTitleEvent,
  Tab,
  CreateTabResult,
  CreateTabOpts,
  TabGroup,
  ReviewComment,
} from "@/types";

export interface ContentSearchMatch {
  relPath: string;
  path: string;
  name: string;
  line: number;
  column: number;
  pre: string;
  match: string;
  post: string;
}

export interface ContentSearchResult {
  results: ContentSearchMatch[];
  truncated: boolean;
}

// ---- Event listeners ----

type MenuActionPayload = { action: string; scope?: string };
interface FileContextMenuPayload {
  path: string;
  isDir: boolean;
  action: string;
}

const unlistenFns: UnlistenFn[] = [];

export async function initRpc() {
  // Idempotent: tear down any prior registration first so a second init (HMR,
  // re-mount) doesn't double-register and fire every CustomEvent twice.
  for (const un of unlistenFns.splice(0)) un();
  const results = await Promise.allSettled([
    listen<MenuActionPayload>("menu-action", (e) => {
      window.dispatchEvent(new CustomEvent("menu-action", { detail: e.payload }));
    }),
    listen<FileContextMenuPayload>("file-context-menu-action", (e) => {
      window.dispatchEvent(
        new CustomEvent("file-context-menu-action", { detail: e.payload }),
      );
    }),
    listen<{ targetDir: string; action: string }>("explorer-background-action", (e) => {
      window.dispatchEvent(
        new CustomEvent("explorer-background-action", { detail: e.payload }),
      );
    }),
listen<string>("file-deleted", (e) => {
      window.dispatchEvent(
        new CustomEvent("file-deleted-external", { detail: e.payload }),
      );
    }),
    listen<TabUpdatedEvent>("tab-updated", (e) => {
      window.dispatchEvent(
        new CustomEvent("tab-updated", { detail: e.payload }),
      );
    }),
    listen<TabTitleEvent>("tab-title", (e) => {
      window.dispatchEvent(
        new CustomEvent("tab-title", { detail: e.payload }),
      );
    }),
  ]);
  for (const r of results) {
    if (r.status === "fulfilled") unlistenFns.push(r.value);
    else console.error("initRpc listen() failed:", r.reason);
  }
}

// ---- Commands (wrapping Tauri invoke) ----

const request = {
  // Directories
  getDirectories: (_p: object): Promise<WorkingDirectory[]> => invoke("get_directories"),
  createDirectory: (p: { path: string }): Promise<WorkingDirectory> =>
    invoke("create_directory", { path: p.path }),
  deleteDirectory: (p: { id: string }): Promise<boolean> =>
    invoke("delete_directory", { id: p.id }),
  renameDirectory: (p: { id: string; name: string }): Promise<WorkingDirectory> =>
    invoke("rename_directory", { id: p.id, name: p.name }),
  reorderDirectories: (p: { ids: string[] }): Promise<boolean> =>
    invoke("reorder_directories", { ids: p.ids }),
  setActiveDirectory: (p: { directoryId: string | null }): Promise<boolean> =>
    invoke("set_active_directory", { directoryId: p.directoryId }),
  getDirectorySettings: (p: { directoryId: string }): Promise<DirectorySettings> =>
    invoke("get_directory_settings", p),
  updateDirectorySettings: (p: { directoryId: string; partial: Partial<DirectorySettings> }): Promise<DirectorySettings> =>
    invoke("update_directory_settings", p),

  // Worktrees
  worktreeCreate: (p: { parentDirectoryId: string; branch: string }): Promise<WorkingDirectory> =>
    invoke("worktree_create", { parentDirectoryId: p.parentDirectoryId, branch: p.branch }),
  worktreeRemove: (p: { id: string; force?: boolean }): Promise<boolean> =>
    invoke("worktree_remove", { id: p.id, force: p.force ?? false }),
  worktreeRename: (p: { id: string; branch: string }): Promise<WorkingDirectory> =>
    invoke("worktree_rename", { id: p.id, branch: p.branch }),

  // Sessions
  createTerminal: (p: { workingDir: string; cols?: number; rows?: number }): Promise<string> =>
    invoke("create_terminal", { workingDir: p.workingDir, cols: p.cols ?? null, rows: p.rows ?? null }),
  killTerminal: (p: { sessionId: string }): Promise<boolean> =>
    invoke("kill_terminal", { sessionId: p.sessionId }),
  // Resize a backgrounded tab's PTY (tabId == agent id) so its size tracks the
  // viewport while its grid WS is closed — avoids a SIGWINCH jump on reactivation.
  tabResize: (p: { tabId: string; cols: number; rows: number }): Promise<boolean> =>
    invoke("tab_resize", { tabId: p.tabId, cols: p.cols, rows: p.rows }),

  // Terminal tabs (Phase 2 RPC)
  tabsCreate: (p: CreateTabOpts): Promise<CreateTabResult> => invoke("tabs_create", { opts: p }),
  tabsList: (p: { directoryId?: string | null }): Promise<Tab[]> =>
    invoke("tabs_list", { directoryId: p.directoryId ?? null }),
  tabsRename: (p: { id: string; label: string }): Promise<Tab> =>
    invoke("tabs_rename", { id: p.id, label: p.label }),
  tabsClose: (p: { id: string }): Promise<boolean> =>
    invoke("tabs_close", { id: p.id }),
  tabsReorder: (p: { ids: string[] }): Promise<boolean> =>
    invoke("tabs_reorder", { ids: p.ids }),
  tabsSessionId: (p: { id: string }): Promise<string | null> =>
    invoke("tabs_session_id", { id: p.id }),
  tabsHasRunningChild: (p: { id: string }): Promise<boolean> =>
    invoke("tabs_has_running_child", { id: p.id }),
  getAgentStates: (): Promise<Array<{
    tabId: string;
    agentState: string;
    agentType: string | null;
    revision: number;
    source: string;
    changedAt: number;
    lastAgentSessionId?: string | null;
    title?: string | null;
  }>> =>
    invoke("get_agent_states"),

  // Tab groups (split layouts)
  groupsList: (p: { directoryId?: string | null }): Promise<TabGroup[]> =>
    invoke("groups_list", { directoryId: p.directoryId ?? null }),
  groupCreate: (p: { directoryId: string; layout: string; activePaneId?: string | null }): Promise<TabGroup> =>
    invoke("group_create", { directoryId: p.directoryId, layout: p.layout, activePaneId: p.activePaneId ?? null }),
  groupUpdateLayout: (p: { id: string; layout: string; activePaneId?: string | null }): Promise<boolean> =>
    invoke("group_update_layout", { id: p.id, layout: p.layout, activePaneId: p.activePaneId ?? null }),
  groupSetActivePane: (p: { id: string; paneId: string }): Promise<boolean> =>
    invoke("group_set_active_pane", { id: p.id, paneId: p.paneId }),
  groupsReorder: (p: { ids: string[] }): Promise<boolean> =>
    invoke("groups_reorder", { ids: p.ids }),
  groupDelete: (p: { id: string }): Promise<boolean> =>
    invoke("group_delete", { id: p.id }),

  // Review comments
  reviewList: (p: { scopeKey: string }): Promise<ReviewComment[]> =>
    invoke("review_list", { scopeKey: p.scopeKey }),
  reviewUpsert: (p: { comment: ReviewComment }): Promise<void> =>
    invoke("review_upsert", { comment: p.comment }),
  reviewRemove: (p: { id: string }): Promise<void> =>
    invoke("review_remove", { id: p.id }),
  reviewClearScope: (p: { scopeKey: string }): Promise<void> =>
    invoke("review_clear_scope", { scopeKey: p.scopeKey }),

  // Utility
  getWsPort: (_p: object): Promise<number> => invoke("get_ws_port"),
  getHomePath: (_p: object): Promise<string> => invoke("get_home_path"),
  fileExists: (p: { path: string }): Promise<boolean> => invoke("file_exists", { path: p.path }),
  toggleMaximize: (_p: object): Promise<boolean> => invoke("toggle_maximize"),
  readFile: (p: { path: string }): Promise<{ content: string; language: string }> =>
    invoke("read_file", { path: p.path }),
  writeFile: (p: {
    path: string;
    content: string;
  }): Promise<{ ok: boolean; mtime: number }> =>
    invoke("write_file", { path: p.path, content: p.content }),
  createFile: (p: { path: string }): Promise<void> =>
    invoke("create_file", { path: p.path }),
  createDir: (p: { path: string }): Promise<void> =>
    invoke("create_dir", { path: p.path }),
  listTree: (p: { dir: string }): Promise<{ entries: import("@/types").TreeEntry[] }> =>
    invoke("list_tree", { dir: p.dir }),
  getFileMtime: (p: { path: string }): Promise<{ mtime: number }> =>
    invoke("get_file_mtime", { path: p.path }),
  resolveRepoRoot: (p: { workingDir: string }): Promise<{ repoRoot: string | null }> =>
    invoke("resolve_repo_root", { workingDir: p.workingDir }),
  prewarmFileIndex: (p: { dir: string }): Promise<void> =>
    invoke("prewarm_file_index", { dir: p.dir }),
  searchFiles: (p: {
    dir: string;
    query: string;
    directoryId?: string;
  }): Promise<{ results: { name: string; path: string; relPath: string }[] }> =>
    invoke("search_files", { dir: p.dir, query: p.query, directoryId: p.directoryId ?? null }),
  searchContent: (p: {
    dir: string;
    query: string;
    caseSensitive?: boolean;
    include?: string;
    exclude?: string;
  }): Promise<ContentSearchResult> =>
    invoke("search_content", {
      dir: p.dir,
      query: p.query,
      caseSensitive: p.caseSensitive ?? false,
      include: p.include ?? "",
      exclude: p.exclude ?? "",
    }),
  touchRecentFile: (p: { directoryId: string; path: string; scopeType?: "directory" | "agent_worktree" }): Promise<boolean> =>
    invoke("touch_recent_file", { directoryId: p.directoryId, path: p.path, scopeType: p.scopeType ?? null }),
  getRecentFiles: (p: { directoryId: string; limit?: number; scopeType?: "directory" | "agent_worktree" }): Promise<{ path: string; openedAt: number }[]> =>
    invoke("get_recent_files", { directoryId: p.directoryId, limit: p.limit ?? null, scopeType: p.scopeType ?? null }),
  watchFile: (p: { path: string }): Promise<boolean> =>
    invoke("watch_file", { path: p.path }),
  unwatchFile: (p: { path: string }): Promise<boolean> =>
    invoke("unwatch_file", { path: p.path }),
  watchDirectory: (p: { path: string }): Promise<boolean> =>
    invoke("watch_directory", { path: p.path }),
  unwatchDirectory: (p: { path: string }): Promise<boolean> =>
    invoke("unwatch_directory", { path: p.path }),
  findProjectIcon: (p: { dir: string }): Promise<string | null> =>
    invoke("find_project_icon", { dir: p.dir }),
  listDirectoryPaths: (p: {
    partial: string;
  }): Promise<{ dirs: string[]; resolved: string }> =>
    invoke("list_directory_paths", { partial: p.partial }),
  getResourceUsage: (_p: object): Promise<ResourceUsage> => invoke("get_resource_usage"),
  getDebugMetrics: (_p: object): Promise<DebugMetrics> => invoke("get_debug_metrics"),
  getAppState: (p: { key: string }): Promise<string | null> => invoke("get_app_state", { key: p.key }),
  setAppState: (p: { key: string; value: string | null }): Promise<boolean> => invoke("set_app_state", { key: p.key, value: p.value }),
  getSettings: (_p: object): Promise<AppSettings> => invoke("get_settings"),
  getSettingsPath: (_p: object): Promise<string> => invoke("get_settings_path"),
  getShortcuts: (_p: object): Promise<Shortcut[]> => invoke("get_shortcuts"),
  getShortcutsPath: (_p: object): Promise<string> => invoke("get_shortcuts_path"),
  updateSettings: (p: { settings: Partial<AppSettings> }): Promise<AppSettings> =>
    invoke("update_settings", { settings: p.settings }),
  getTabs: (p: {
    scopeType: string;
    scopeId: string;
  }): Promise<StoredTabState | null> =>
    invoke("get_tabs", { scopeType: p.scopeType, scopeId: p.scopeId }),
  saveTabs: (p: {
    scopeType: string;
    scopeId: string;
    state: StoredTabState;
  }): Promise<boolean> =>
    invoke("save_tabs", { scopeType: p.scopeType, scopeId: p.scopeId, tabState: p.state }),
  pickDirectory: (p: { startingFolder?: string }): Promise<{ path: string | null }> =>
    invoke("pick_directory", { startingFolder: p.startingFolder ?? null }),
  showFileContextMenu: (p: { path: string; isDir: boolean; hasClipboard: boolean }): Promise<boolean> =>
    invoke("show_file_context_menu", { path: p.path, isDir: p.isDir, hasClipboard: p.hasClipboard }),
  showBatchFileContextMenu: (p: { paths: string[] }): Promise<boolean> =>
    invoke("show_batch_file_context_menu", { paths: p.paths }),
  showExplorerBackgroundMenu: (p: { targetDir: string; hasClipboard: boolean }): Promise<boolean> =>
    invoke("show_explorer_background_menu", { targetDir: p.targetDir, hasClipboard: p.hasClipboard }),
  showSettingsContextMenu: (_p: object): Promise<boolean> =>
    invoke("show_settings_context_menu"),
  pastePath: (p: { source: string; targetDir: string; cut: boolean }): Promise<{ dest: string }> =>
    invoke("paste_path", { source: p.source, targetDir: p.targetDir, cut: p.cut }),
  revealInFinder: (p: { path: string }): Promise<boolean> =>
    invoke("reveal_in_finder", { path: p.path }),
  trashFile: (p: { path: string }): Promise<boolean> =>
    invoke("trash_file", { path: p.path }),
  renamePath: (p: { oldPath: string; newPath: string }): Promise<boolean> =>
    invoke("rename_path", { oldPath: p.oldPath, newPath: p.newPath }),
  listUserThemes: (_p: object): Promise<{ name: string; json: string }[]> =>
    invoke("list_user_themes"),

  // Shadow tree
  shadowCommit: (p: { dir: string; relPath: string; content: string }): Promise<string> =>
    invoke("shadow_commit", { dir: p.dir, relPath: p.relPath, content: p.content }),
  shadowRead: (p: { dir: string; relPath: string }): Promise<string | null> =>
    invoke("shadow_read", { dir: p.dir, relPath: p.relPath }),
  shadowReadWithBaseline: (p: { dir: string; relPath: string }): Promise<{ content: string; baselineHash: string } | null> =>
    invoke("shadow_read_with_baseline", { dir: p.dir, relPath: p.relPath }),
  shadowOnSaved: (p: { dir: string; relPath: string; content: string }): Promise<void> =>
    invoke("shadow_on_saved", { dir: p.dir, relPath: p.relPath, content: p.content }),
  shadowRemove: (p: { dir: string; relPath: string }): Promise<void> =>
    invoke("shadow_remove", { dir: p.dir, relPath: p.relPath }),

  // Git
  gitInit: (p: { path: string }): Promise<void> =>
    invoke("git_init", { path: p.path }),
  gitStatus: (p: { path: string }): Promise<GitStatus> =>
    invoke("git_status", { path: p.path }),
  gitStage: (p: { path: string; files: string[] }): Promise<void> =>
    invoke("git_stage", { path: p.path, files: p.files }),
  gitUnstage: (p: { path: string; files: string[] }): Promise<void> =>
    invoke("git_unstage", { path: p.path, files: p.files }),
  gitStageAll: (p: { path: string }): Promise<void> =>
    invoke("git_stage_all", { path: p.path }),
  gitUnstageAll: (p: { path: string }): Promise<void> =>
    invoke("git_unstage_all", { path: p.path }),
  gitDiscardFiles: (p: { path: string; files: string[] }): Promise<void> =>
    invoke("git_discard_files", { path: p.path, files: p.files }),
  cancelGitOperation: (p: { path: string }): Promise<boolean> =>
    invoke("cancel_git_operation", { path: p.path }),
  gitCommit: (p: { path: string; message: string }): Promise<string> =>
    invoke("git_commit", { path: p.path, message: p.message }),
  gitDiff: (p: { path: string; file: string; staged: boolean }): Promise<GitDiffResult> =>
    invoke("git_diff", { path: p.path, file: p.file, staged: p.staged }),
  gitWatch: (p: { path: string }): Promise<void> =>
    invoke("git_watch", { path: p.path }),
  gitUnwatch: (p: { path: string }): Promise<void> =>
    invoke("git_unwatch", { path: p.path }),
  setSourceControlVisible: (p: { visible: boolean }): Promise<boolean> =>
    invoke("set_source_control_visible", { visible: p.visible }),

  // Git commit graph
  gitCommitLog: (p: { path: string; count: number; skip: number }): Promise<GitCommitLogResult> =>
    invoke("git_commit_log", p),
  gitCommitFiles: (p: { path: string; commitId: string }): Promise<{ files: GitCommitFileEntry[] }> =>
    invoke("git_commit_files", { path: p.path, commitId: p.commitId }),
  gitCommitFileDiff: (p: { path: string; commitId: string; file: string }): Promise<GitDiffResult> =>
    invoke("git_commit_file_diff", { path: p.path, commitId: p.commitId, file: p.file }),
  gitCherryPick: (p: { path: string; commitId: string }): Promise<void> =>
    invoke("git_cherry_pick", { path: p.path, commitId: p.commitId }),
  gitRevert: (p: { path: string; commitId: string }): Promise<void> =>
    invoke("git_revert", { path: p.path, commitId: p.commitId }),
  gitBranchName: (p: { path: string }): Promise<string> =>
    invoke("git_branch_name", p),
  gitListBranches: (p: { path: string }): Promise<GitBranch[]> =>
    invoke("git_list_branches", p),
  gitCreateBranch: (p: { path: string; name: string; fromRef?: string }): Promise<void> =>
    invoke("git_create_branch", p),
  gitRenameBranch: (p: { path: string; oldName: string; newName: string }): Promise<void> =>
    invoke("git_rename_branch", p),
  gitCheckoutBranch: (p: { path: string; name: string; isRemote: boolean; remoteRef?: string }): Promise<void> =>
    invoke("git_checkout_branch", p),
  gitPull: (p: { path: string }): Promise<string> =>
    invoke("git_pull", p),
  gitPush: (p: { path: string }): Promise<string> =>
    invoke("git_push", p),
  gitPublish: (p: { path: string }): Promise<string> =>
    invoke("git_publish", p),
  gitFetch: (p: { path: string }): Promise<string> =>
    invoke("git_fetch", p),

  // Sidebar tabs
  getSidebarTabs: (p: { directoryId: string; scopeType?: "directory" | "agent_worktree" }): Promise<SidebarTabRow[]> =>
    invoke("get_sidebar_tabs", { directoryId: p.directoryId, scopeType: p.scopeType ?? null }),
  saveSidebarTabs: (p: { directoryId: string; scopeType?: "directory" | "agent_worktree"; tabs: SidebarTabRow[]; activeTabId: string; listColumnWidth: number; rightSidebarView?: string; filePanelActiveId?: string | null }): Promise<boolean> =>
    invoke("save_sidebar_tabs", {
      directoryId: p.directoryId,
      scopeType: p.scopeType ?? null,
      tabs: p.tabs,
      activeTabId: p.activeTabId,
      listColumnWidth: p.listColumnWidth,
      rightSidebarView: p.rightSidebarView ?? null,
      filePanelActiveId: p.filePanelActiveId ?? null,
    }),
  getSidebarState: (p: { directoryId: string; scopeType?: "directory" | "agent_worktree" }): Promise<SidebarState | null> =>
    invoke("get_sidebar_state", { directoryId: p.directoryId, scopeType: p.scopeType ?? null }),

  // Notes (keyed by workspace root directory)
  notesDirPath: (p: { directoryId: string }): Promise<string> =>
    invoke("notes_dir_path", { directoryId: p.directoryId }),
  notesList: (p: { directoryId: string }): Promise<import("@/types").NoteMeta[]> =>
    invoke("notes_list", { directoryId: p.directoryId }),
  notesCreate: (p: { directoryId: string; title: string }): Promise<import("@/types").NoteMeta> =>
    invoke("notes_create", { directoryId: p.directoryId, title: p.title }),
  notesRename: (p: { directoryId: string; slug: string; title: string }): Promise<import("@/types").NoteMeta> =>
    invoke("notes_rename", { directoryId: p.directoryId, slug: p.slug, title: p.title }),
  notesDelete: (p: { directoryId: string; slug: string }): Promise<void> =>
    invoke("notes_delete", { directoryId: p.directoryId, slug: p.slug }),

  // Browser favorites & history (workspace-scoped)
  browserFavoritesList: (p: { directoryId: string }): Promise<import("@/types").BrowserFavorite[]> =>
    invoke("browser_favorites_list", { directoryId: p.directoryId }),
  browserFavoriteAdd: (p: { directoryId: string; url: string; title: string; faviconUrl?: string | null }): Promise<boolean> =>
    invoke("browser_favorite_add", p),
  browserFavoriteRemove: (p: { directoryId: string; url: string }): Promise<boolean> =>
    invoke("browser_favorite_remove", p),
  browserHistoryList: (p: { directoryId: string; limit?: number }): Promise<import("@/types").BrowserHistoryItem[]> =>
    invoke("browser_history_list", p),
  browserHistoryRecord: (p: { directoryId: string; url: string; title: string; faviconUrl?: string | null }): Promise<boolean> =>
    invoke("browser_history_record", p),
  browserHistoryClear: (p: { directoryId: string }): Promise<boolean> =>
    invoke("browser_history_clear", p),
  browserFavoriteRename: (p: { directoryId: string; url: string; title: string }): Promise<boolean> =>
    invoke("browser_favorite_rename", p),
  browserHistoryRemove: (p: { directoryId: string; url: string }): Promise<boolean> =>
    invoke("browser_history_remove", p),

  // MCP agent registration (Settings → MCP)
  mcpSupportedAgents: (_p: object): Promise<import("@/types").McpAgentInfo[]> =>
    invoke("mcp_supported_agents"),
  mcpAgentStatus: (p: { agent: string }): Promise<import("@/types").McpAgentStatus> =>
    invoke("mcp_agent_status", { agent: p.agent }),
  mcpInstall: (p: { agent: string }): Promise<void> => invoke("mcp_install", { agent: p.agent }),
  mcpInstallAll: (_p: object): Promise<string[]> => invoke("mcp_install_all"),
  mcpUninstall: (p: { agent: string }): Promise<void> => invoke("mcp_uninstall", { agent: p.agent }),
  mcpManualCommands: (p: { agent: string }): Promise<string> =>
    invoke("mcp_manual_commands", { agent: p.agent }),
};

export function useRpc() {
  return { request };
}
