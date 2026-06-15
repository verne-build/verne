use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDirectory {
    pub id: String,
    pub path: String,
    pub name: String,
    pub repo_root: Option<String>,
    pub created_at: i64,
    pub sort_order: i64,
    /// Phase 7: if set, this directory is a worktree of another directory.
    pub parent_directory_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_base_ref: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SidebarTabRow {
    pub directory_id: String,
    pub tab_id: String,
    pub tab_type: String,
    pub label: String,
    pub position: i64,
    pub cursor_line: Option<u32>,
    pub cursor_column: Option<u32>,
    pub scroll_top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_rel_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_staged: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_commit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_commit_short_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_url: Option<String>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SidebarState {
    pub directory_id: String,
    pub active_tab_id: String,            // legacy, still read for migration
    pub list_column_width: f64,           // legacy, ignored after migration
    pub right_sidebar_view: Option<String>,
    pub file_panel_active_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveSidebarTabsPayload {
    pub tabs: Vec<SidebarTabRow>,
    pub active_tab_id: String,
    pub list_column_width: f64,
    pub right_sidebar_view: Option<String>,
    pub file_panel_active_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffStat {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffStats {
    pub total_added: u32,
    pub total_deleted: u32,
    pub files: Vec<FileDiffStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub added: u32,
    pub deleted: u32,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<GitFileEntry>,
    pub current_branch: Option<String>,
    pub upstream: Option<String>,
    pub has_remote: bool,
    pub default_remote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationProgress {
    pub path: String,
    pub action: String,
    pub completed: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub original: String,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parent_ids: Vec<String>,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub added: u32,
    pub deleted: u32,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLogResult {
    pub commits: Vec<CommitInfo>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub full_ref: String,
    pub is_remote: bool,
    pub is_head: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_ignored: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonDiagnostics {
    pub daemon_pid: u32,
    pub tab_child_pids: Vec<TabChildPid>,
    pub agent_count: u32,
    pub active_sessions: u32,
    pub file_watchers: u32,
    pub directory_watchers: u32,
    pub git_watchers: u32,
    pub cached_file_indexes: u32,
    pub cached_file_paths: u32,
    pub source_control_visible: bool,
}

/// Counters owned by the sidecar (watchers, file-index cache). Electron merges
/// these with the daemon's `DaemonDiagnostics` (sessions/tab pids) for the
/// resource monitor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarDiagnostics {
    pub sidecar_pid: u32,
    /// Tabs with a known agent type (DB-derived; the daemon can't compute this).
    pub agent_count: u32,
    pub file_watchers: u32,
    pub directory_watchers: u32,
    pub git_watchers: u32,
    pub cached_file_indexes: u32,
    pub cached_file_paths: u32,
    pub source_control_visible: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabChildPid {
    pub tab_id: String,
    pub label: String,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTabState {
    pub tabs: Vec<StoredTab>,
    pub active_tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTab {
    pub id: String,
    #[serde(rename = "type")]
    pub tab_type: String,
    pub label: String,
    pub pinned: bool,
    pub file_path: Option<String>,
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LanguageOverrideSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_tab_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_insert_spaces: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_word_wrap: Option<bool>,
}

// Defaults are owned by Electron (src/lib/defaultSettings.ts), pushed to the
// sidecar via `set_config`. Rust no longer generates meaningful defaults: the
// derived `Default` is an empty structural fallback so a partial/missing config
// still deserializes (container `default`) without inventing product values.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub editor_tab_size: u32,
    pub editor_insert_spaces: bool,
    pub auto_save: bool,
    pub editor_font_family: String,
    pub editor_font_size: u32,
    pub editor_line_height: u32,
    pub editor_word_wrap: bool,
    pub editor_line_numbers: bool,
    pub editor_font_ligatures: bool,
    pub editor_sticky_scroll: bool,
    pub editor_minimap: bool,
    pub editor_minimap_render_characters: bool,
    pub editor_minimap_scale: u32,
    pub editor_minimap_show_slider: String,
    pub editor_minimap_autohide: bool,
    pub editor_multi_cursor_modifier: String,
    pub terminal_renderer: String,
    pub terminal_font_family: String,
    pub terminal_font_size: u32,
    pub terminal_line_height: f64,
    pub terminal_font_ligatures: bool,
    /// Map bold text on ANSI colors 0-7 to the bright 8-15 variant.
    pub terminal_bold_is_bright: bool,
    /// Minimum fg/bg WCAG contrast ratio (1 = off).
    pub terminal_minimum_contrast: f64,
    /// Default cursor shape: "block" | "beam" | "underline".
    pub terminal_cursor_style: String,
    pub terminal_cursor_blink: bool,
    pub editor_font_weight: String,
    pub terminal_font_weight: String,
    pub terminal_font_weight_bold: String,
    /// "system" follows OS preference. "dark" / "light" pin one mode.
    pub appearance: String,
    /// Theme key used when the effective mode is dark.
    pub dark_theme: String,
    /// Theme key used when the effective mode is light. Null until a light theme is installed.
    pub light_theme: Option<String>,
    pub files_exclude: std::collections::HashMap<String, bool>,
    pub lsp_enabled: bool,
    /// When true, suppress agent notifications while Verne is focused.
    pub notifications_focus_gate: bool,
    /// Default view for markdown files: "preview" or "edit".
    pub markdown_default_view: String,
    pub review_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_editor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_editors: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_agent_types: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktrees_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceSettings>,
    #[serde(flatten)]
    pub language_overrides: HashMap<String, LanguageOverrideSettings>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
// `default` so settings written before newer fields existed still deserialize.
#[serde(rename_all = "camelCase", default)]
pub struct VoiceSettings {
    pub enabled: bool,
    pub stt_model: String,
    pub dictation_mode: String,
    pub hotkey: String,
    pub language: String,
    pub confirm_before_insert: bool,
    pub dictionary_enabled: bool,
    pub custom_terms: String,
    pub convert_numbers: bool,
}

#[allow(dead_code)]
pub const WS_PORT: u16 = 9600;
#[allow(dead_code)]
pub const WS_PORT_DEV: u16 = 9601;

#[derive(Debug, Clone)]
pub struct SessionStartMeta {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    pub directory_id: String,
    pub label: String,
    pub cwd: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub last_agent_type: Option<String>,
    pub last_agent_session_id: Option<String>,
    /// Last known agent state (working/blocked/idle/unknown). Persisted so
    /// the dot stays correct across app reloads. Reset to NULL when the
    /// daemon restarts (PTYs die with it).
    pub last_agent_state: Option<String>,
    /// True once the user manually renamed this tab. Locks the label:
    /// OSC/process auto-naming never overrides a user-named tab.
    #[serde(default)]
    pub user_renamed: bool,
}

/// A split layout grouping one or more panes (each pane is a `Tab`). Rendered
/// as a single pill in the tab bar. `layout` is an opaque JSON tree — the
/// frontend owns its semantics (leaf `{pane}` / internal `{direction,children,sizes}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabGroup {
    pub id: String,
    pub directory_id: String,
    pub sort_order: i64,
    pub active_pane_id: Option<String>,
    pub layout: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSessionRow {
    pub session_id: String,
    pub tab_id: String,
    pub agent_type: String,
    pub working_dir: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabUpdatedEvent {
    pub tab_id: String,
    pub agent_type: Option<String>,
    pub agent_state: crate::services::detect::AgentState,
    pub last_agent_session_id: Option<String>,
    /// Name of the current foreground command when no agent owns the
    /// tab (e.g., "zsh" at the prompt, "git" while git runs, "vim" in
    /// vim). None when an agent is detected — the agent name takes
    /// precedence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTabOpts {
    pub directory_id: String,
    pub label: Option<String>,
    pub cwd: Option<String>,
}

/// Everything the daemon needs to spawn a tab's PTY, resolved by the sidecar
/// from the DB. The sidecar inserts the tab row and returns this plan; Electron
/// hands it to the daemon's `tab_spawn`. Carries the display labels so the
/// daemon can emit `tab-bell` without a DB of its own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSpawnPlan {
    pub tab_id: String,
    pub cwd: String,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub directory_name: Option<String>,
    #[serde(default)]
    pub tab_label: Option<String>,
}

/// Returned by the sidecar's `tab_create_row`: the inserted tab plus the spawn
/// plan Electron forwards to the daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabCreateResult {
    pub tab: Tab,
    pub spawn_plan: TabSpawnPlan,
}
