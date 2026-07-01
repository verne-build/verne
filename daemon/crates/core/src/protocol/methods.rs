//! Canonical method names for the RPC. After the minimal-daemon refactor
//! (see docs/minimal-daemon-refactor.md), the daemon's RPC surface is
//! deliberately small: PTY/tabs operations, detection snapshot, and a
//! handful of system metrics + font resolution that haven't been
//! migrated yet.

pub const PING: &str = "ping";

// system.rs — still RPC-forwarded (touch session counts).
pub const GET_DAEMON_DIAGNOSTICS: &str = "get_daemon_diagnostics";

// tabs — split across processes. Row/DB methods (sidecar) vs PTY methods
// (daemon). The composite `tabs_create`/`tabs_close`/`tabs_session_id` flows are
// orchestrated in Electron main over both processes (Star topology).
pub const TABS_LIST: &str = "tabs_list";
pub const TABS_RENAME: &str = "tabs_rename";
pub const TABS_REORDER: &str = "tabs_reorder";

// sidecar tab row methods (DB only, no PTY)
pub const TAB_CREATE_ROW: &str = "tab_create_row";
pub const TAB_SPAWN_PLAN: &str = "tab_spawn_plan";
pub const TAB_DELETE_ROW: &str = "tab_delete_row";
// Slice 5b: Electron owns the tab DB writes — it forwards agent-shadow teardown
// on close.
pub const AGENT_SHADOW_CLEANUP: &str = "agent_shadow_cleanup";

// daemon PTY methods for tabs (operate on the live SessionManager)
pub const TAB_SPAWN: &str = "tab_spawn";
pub const TAB_KILL: &str = "tab_kill";
// Resize a tab's PTY by id without a connected grid WS session, so backgrounded
// tabs stay sized to the viewport and reactivation isn't a SIGWINCH jump.
pub const TAB_RESIZE: &str = "tab_resize";
pub const LIST_LIVE_TAB_IDS: &str = "list_live_tab_ids";
pub const TABS_HAS_RUNNING_CHILD: &str = "tabs_has_running_child";

// sidecar diagnostics (watcher/cache counters; daemon serves the session half)
pub const GET_SIDECAR_DIAGNOSTICS: &str = "get_sidecar_diagnostics";

// git (daemon owns git workers + emits status events)
pub const GIT_STATUS: &str = "git_status";
pub const GIT_INIT: &str = "git_init";
pub const GIT_STAGE: &str = "git_stage";
pub const GIT_UNSTAGE: &str = "git_unstage";
pub const GIT_STAGE_ALL: &str = "git_stage_all";
pub const GIT_UNSTAGE_ALL: &str = "git_unstage_all";
pub const GIT_DISCARD_FILES: &str = "git_discard_files";
pub const GIT_COMMIT: &str = "git_commit";
pub const GIT_DIFF: &str = "git_diff";
pub const GIT_COMMIT_LOG: &str = "git_commit_log";
pub const GIT_COMMIT_FILES: &str = "git_commit_files";
pub const GIT_COMMIT_FILE_DIFF: &str = "git_commit_file_diff";
pub const GIT_CHERRY_PICK: &str = "git_cherry_pick";
pub const GIT_REVERT: &str = "git_revert";
pub const GIT_BRANCH_NAME: &str = "git_branch_name";
pub const GIT_LIST_BRANCHES: &str = "git_list_branches";
pub const GIT_CREATE_BRANCH: &str = "git_create_branch";
pub const GIT_RENAME_BRANCH: &str = "git_rename_branch";
pub const GIT_CHECKOUT_BRANCH: &str = "git_checkout_branch";
pub const GIT_PULL: &str = "git_pull";
pub const GIT_PUSH: &str = "git_push";
pub const GIT_PUBLISH: &str = "git_publish";
pub const GIT_FETCH: &str = "git_fetch";
pub const GIT_FORCE_PUSH: &str = "git_force_push";
pub const GIT_FAST_FORWARD: &str = "git_fast_forward";
pub const GIT_WATCH: &str = "git_watch";
pub const GIT_UNWATCH: &str = "git_unwatch";
pub const SET_SOURCE_CONTROL_VISIBLE: &str = "set_source_control_visible";
pub const CANCEL_GIT_OPERATION: &str = "cancel_git_operation";

// sessions.rs — PTY lifecycle
pub const CREATE_TERMINAL: &str = "create_terminal";
pub const KILL_TERMINAL: &str = "kill_terminal";

// detection — host polls per tick; daemon resolves `tcgetpgrp` locally
// since the PTY master fd is a kernel handle the host can't touch.

// directories (DB CRUD)
pub const GET_DIRECTORIES: &str = "get_directories";
pub const CREATE_DIRECTORY: &str = "create_directory";
pub const DELETE_DIRECTORY: &str = "delete_directory";
// Electron owns the directory row (slice 5); it deletes the row then calls this
// DB-free RPC so the sidecar tears down the subtree's watchers/shadow trees/caches.
pub const EVICT_DIRECTORY_RESOURCES: &str = "evict_directory_resources";
pub const RENAME_DIRECTORY: &str = "rename_directory";
pub const REORDER_DIRECTORIES: &str = "reorder_directories";
pub const SET_ACTIVE_DIRECTORY: &str = "set_active_directory";
pub const GET_DIRECTORY_SETTINGS: &str = "get_directory_settings";
pub const UPDATE_DIRECTORY_SETTINGS: &str = "update_directory_settings";

// worktrees — git-only ops (DB rows owned by Electron; these return resolved fields)
pub const WORKTREE_CREATE_GIT: &str = "worktree_create_git";
pub const WORKTREE_REMOVE_GIT: &str = "worktree_remove_git";
pub const WORKTREE_RENAME_GIT: &str = "worktree_rename_git";

// tab groups (split layouts)
pub const GROUPS_LIST: &str = "groups_list";
pub const GROUP_CREATE: &str = "group_create";
pub const GROUP_UPDATE_LAYOUT: &str = "group_update_layout";
pub const GROUP_SET_ACTIVE_PANE: &str = "group_set_active_pane";
pub const GROUPS_REORDER: &str = "groups_reorder";
pub const GROUP_DELETE: &str = "group_delete";

// settings + app state
pub const GET_SETTINGS: &str = "get_settings";
pub const GET_SETTINGS_PATH: &str = "get_settings_path";
pub const UPDATE_SETTINGS: &str = "update_settings";
pub const SET_CONFIG: &str = "set_config";
pub const GET_APP_STATE: &str = "get_app_state";
pub const SET_APP_STATE: &str = "set_app_state";
pub const LIST_USER_THEMES: &str = "list_user_themes";

// editor tabs (persistence)
pub const GET_TABS: &str = "get_tabs";
pub const SAVE_TABS: &str = "save_tabs";

// sidebar tabs/state
pub const GET_SIDEBAR_TABS: &str = "get_sidebar_tabs";
pub const SAVE_SIDEBAR_TABS: &str = "save_sidebar_tabs";
pub const GET_SIDEBAR_STATE: &str = "get_sidebar_state";

// notes
pub const NOTES_DIR_PATH: &str = "notes_dir_path";
pub const NOTES_LIST: &str = "notes_list";
pub const NOTES_CREATE: &str = "notes_create";
pub const NOTES_RENAME: &str = "notes_rename";
pub const NOTES_DELETE: &str = "notes_delete";

// files.rs (filesystem CRUD + tree)
pub const READ_FILE: &str = "read_file";
pub const WRITE_FILE: &str = "write_file";
pub const CREATE_FILE: &str = "create_file";
pub const CREATE_DIR: &str = "create_dir";
pub const LIST_TREE: &str = "list_tree";
pub const GET_FILE_MTIME: &str = "get_file_mtime";
pub const PASTE_PATH: &str = "paste_path";
pub const FIND_PROJECT_ICON: &str = "find_project_icon";
pub const RENAME_PATH: &str = "rename_path";
pub const FILE_EXISTS: &str = "file_exists";

// file_search.rs (index + fuzzy search + recent files)
pub const SEARCH_FILES: &str = "search_files";
pub const SEARCH_CONTENT: &str = "search_content";
pub const LIST_DIRECTORY_PATHS: &str = "list_directory_paths";
pub const PREWARM_FILE_INDEX: &str = "prewarm_file_index";
pub const TOUCH_RECENT_FILE: &str = "touch_recent_file";
pub const GET_RECENT_FILES: &str = "get_recent_files";

// file_watch.rs (notify watchers → event bus)
pub const WATCH_FILE: &str = "watch_file";
pub const UNWATCH_FILE: &str = "unwatch_file";
pub const WATCH_DIRECTORY: &str = "watch_directory";
pub const UNWATCH_DIRECTORY: &str = "unwatch_directory";

// shadow.rs (per-dir shadow git tree)
pub const SHADOW_COMMIT: &str = "shadow_commit";
pub const SHADOW_READ: &str = "shadow_read";
pub const SHADOW_READ_WITH_BASELINE: &str = "shadow_read_with_baseline";
pub const SHADOW_DIFF: &str = "shadow_diff";
pub const SHADOW_HISTORY: &str = "shadow_history";
pub const SHADOW_READ_AT: &str = "shadow_read_at";
pub const SHADOW_ON_SAVED: &str = "shadow_on_saved";
pub const SHADOW_REMOVE: &str = "shadow_remove";

// mcp.rs (agent MCP registration)
pub const MCP_SUPPORTED_AGENTS: &str = "mcp_supported_agents";
pub const MCP_AGENT_STATUS: &str = "mcp_agent_status";
pub const MCP_INSTALL: &str = "mcp_install";
pub const MCP_INSTALL_ALL: &str = "mcp_install_all";
pub const MCP_UNINSTALL: &str = "mcp_uninstall";
pub const MCP_MANUAL_COMMANDS: &str = "mcp_manual_commands";

// system util
pub const GET_WS_PORT: &str = "get_ws_port";
pub const GET_HOME_PATH: &str = "get_home_path";
pub const RESOLVE_REPO_ROOT: &str = "resolve_repo_root";

// hook config (daemon) + agent state hydration
pub const GET_HOOK_CONFIG: &str = "__get_hook_config";
pub const GET_AGENT_STATES: &str = "get_agent_states";
pub const EXPLAIN_DETECTION: &str = "__explain_detection";

// sidecar shadow on hook + resync
pub const AGENT_SHADOW_ON_HOOK: &str = "agent_shadow_on_hook";
pub const AGENT_SHADOW_RESYNC: &str = "agent_shadow_resync";
