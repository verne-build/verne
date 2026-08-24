// --- Data model ---

export interface DirectorySettings {
  defaultBaseRef?: string;
}

export interface WorkingDirectory {
  id: string;
  path: string;
  name: string;
  repoRoot?: string;
  createdAt: number;
  sortOrder: number;
  /** Phase 7: if set, this directory is a worktree of another directory. */
  parentDirectoryId?: string;
}

export type SidebarTabType =
  | "file"
  | "diff" // legacy compatibility until Task 7 narrows the union
  | "browser"
  | "sourceControl"
  | "commits"
  | "search"
  | "notes"
  | "explorer";

export interface SidebarTabRow {
  directoryId: string;
  tabId: string;
  tabType: SidebarTabType;
  label: string;
  position: number;
  cursorLine?: number;
  cursorColumn?: number;
  scrollTop?: number;
  diffSource?: "sc" | "commit";
  diffRelPath?: string;
  diffStaged?: boolean;
  diffCommitId?: string;
  diffCommitShortId?: string;
  browserUrl?: string | null;
  pinned?: boolean;
}

export interface SidebarState {
  directoryId: string;
  activeTabId: string;            // legacy, used during migration only
  listColumnWidth: number;        // legacy, ignored
  rightSidebarView?: string;
  filePanelActiveId?: string;
}

export interface FilePanelFileTab {
  kind: "file";
  id: string;            // == filePath
  filePath: string;
  label: string;
  cursorLine?: number;
  cursorColumn?: number;
  scrollTop?: number;
  positionVersion?: number;
  // VS Code-style preview tab: italic, reuses the single ephemeral slot, and is
  // promoted to a permanent tab on double-click or first edit. In-memory only.
  ephemeral?: boolean;
}

export interface FilePanelSourceControlTab {
  kind: "sourceControl";
  id: "__sc__";
}

export interface FilePanelCommitsTab {
  kind: "commits";
  id: "__commits__";
}

export interface FilePanelExplorerTab {
  kind: "explorer";
  id: string; // explorer:<uuid>
}

export interface FilePanelNotesTab {
  kind: "notes";
  id: "__notes__";
}

export interface FilePanelSearchTab {
  kind: "search";
  id: "__search__";
}

export interface FilePanelBrowserTab {
  kind: "browser";
  id: string;          // stable per browser tab, e.g. `browser:<uuid>`
  label: string;       // page title or host
  browserUrl: string | null;
  faviconUrl?: string; // derived from origin on navigate, not persisted
}

export type FilePanelTab =
  | FilePanelFileTab
  | FilePanelSourceControlTab
  | FilePanelCommitsTab
  | FilePanelExplorerTab
  | FilePanelNotesTab
  | FilePanelSearchTab
  | FilePanelBrowserTab;

export type OpenableTabKind =
  | "sourceControl"
  | "commits"
  | "search"
  | "notes"
  | "explorer"
  | "browser";

export const SC_TAB_ID = "__sc__" as const;
export const COMMITS_TAB_ID = "__commits__" as const;
/** Legacy migration marker, not a live explorer id. */
export const EXPLORER_TAB_ID = "__explorer__" as const;
export const NOTES_TAB_ID = "__notes__" as const;
export const SEARCH_TAB_ID = "__search__" as const;

/** A note as listed in the sidebar. */
export interface NoteMeta {
  slug: string;
  title: string;
}

/** A note's content (frontmatter split out server-side). */
export interface NoteContent {
  slug: string;
  title: string;
  body: string;
}

export interface BrowserFavorite {
  url: string;
  title: string;
  faviconUrl: string | null;
  addedAt: number;
}

export interface BrowserHistoryItem {
  url: string;
  title: string;
  faviconUrl: string | null;
  visitedAt: number;
}

/** Per-agent MCP registration status for the Settings section. */
export interface McpAgentInfo {
  key: string;
  displayName: string;
}

export interface McpAgentStatus {
  key: string;
  displayName: string;
  /** "unknown" means supported but not checked in this settings session. */
  status: "unknown" | "notDetected" | "detected" | "registered" | "needsApproval" | "error";
  detail?: string;
}

export interface FileDiffStat {
  path: string;
  added: number;
  deleted: number;
}

export interface AgentDiffStats {
  totalAdded: number;
  totalDeleted: number;
  files: FileDiffStat[];
}

export interface GitFileEntry {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "U";
  added: number;
  deleted: number;
  isBinary: boolean;
}

export interface GitStatus {
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  currentBranch?: string | null;
  upstream?: string | null;
  hasRemote?: boolean;
  defaultRemote?: string | null;
}

export interface GitOperationProgress {
  path: string;
  action: "stage" | "unstage";
  completed: number;
  total: number;
}

export interface GitDiffResult {
  original: string;
  modified: string;
}

export interface GitCommitInfo {
  id: string;
  shortId: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  parentIds: string[];
  refs: string[];
}

export interface GitCommitFileEntry {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R";
  added: number;
  deleted: number;
  isBinary: boolean;
}

export interface GitCommitLogResult {
  commits: GitCommitInfo[];
  hasMore: boolean;
}

export interface GitBranch {
  name: string;
  fullRef: string;
  isRemote: boolean;
  isHead: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  isIgnored?: boolean;
}

export interface ResourceUsage {
  cpu: number;
  ram: number;
  tabCount: number;
  lspCount: number;
}

export interface ProcessBreakdown {
  name: string;
  ram: number;
  cpu: number;
  /** Pane rows carry the owning pane's backend tab id; core rows omit it. */
  tabId?: string;
}

export interface DebugMetrics {
  activeSessions: number;
  fileWatchers: number;
  directoryWatchers: number;
  gitWatchers: number;
  cachedFileIndexes: number;
  cachedFilePaths: number;
  lspCount: number;
  sourceControlVisible: boolean;
  processBreakdown: ProcessBreakdown[];
  /** Aggregate totals computed from the SAME sample as processBreakdown, so the
   *  headline RAM/CPU always reconcile with the per-process rows below. */
  usage: ResourceUsage;
}

export interface StoredTabState {
  tabs: { id: string; type: string; label: string; pinned: boolean; filePath?: string; agentId?: string; scrollTop?: number; cursorLine?: number; cursorColumn?: number }[];
  activeTabId: string;
  dirtyFilePaths?: string[];
}

export interface LanguageOverrideSettings {
  editorTabSize?: number;
  editorInsertSpaces?: boolean;
  editorWordWrap?: boolean;
}

export interface AppSettings {
  editorTabSize: number;
  editorInsertSpaces: boolean;
  autoSave: boolean;
  editorFontFamily: string;
  editorFontSize: number;
  editorLineHeight: number;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  editorFontLigatures: boolean;
  editorStickyScroll: boolean;
  editorMinimap: boolean;
  editorMinimapRenderCharacters: boolean;
  editorMinimapScale: number;
  editorMinimapShowSlider: "always" | "mouseover";
  editorMinimapAutohide: boolean;
  editorMultiCursorModifier: "alt" | "ctrlCmd";
  terminalRenderer: "webgl" | "canvas";
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  /** Inner padding (px) around the terminal cell grid. */
  terminalPadding: number;
  terminalFontLigatures: boolean;
  /** Map bold text on ANSI colors 0-7 to the bright 8-15 variant. */
  terminalBoldIsBright: boolean;
  /** Minimum fg/bg WCAG contrast ratio (1 = off; e.g. 3 lifts unreadable text). */
  terminalMinimumContrast: number;
  /** Default cursor shape when the program hasn't set one (DECSCUSR still wins). */
  terminalCursorStyle: "block" | "beam" | "underline";
  terminalCursorBlink: boolean;
  editorFontWeight: string;
  terminalFontWeight: string;
  terminalFontWeightBold: string;
  /** "system" follows OS preference. "dark" / "light" pin one mode. */
  appearance: "system" | "dark" | "light";
  /** Theme key used when the effective mode is dark. */
  darkTheme: string;
  /** Theme key used when the effective mode is light. Null until a light theme is installed. */
  lightTheme: string | null;
  filesExclude: Record<string, boolean>;
  lspEnabled: boolean;
  notificationsFocusGate: boolean;
  /** Toast alerts for agent state transitions while Verne is focused. */
  notificationsInApp: boolean;
  /** Play a sound with notifications. */
  notificationsSound: boolean;
  markdownDefaultView: "preview" | "edit";
  reviewAgent: string;
  defaultEditor?: string;
  directoryEditors?: Record<string, string>;
  directoryAgentTypes?: Record<string, string>;
  worktreesRoot?: string;
  /** Voice dictation (speech-to-text) settings. */
  voice?: VoiceSettings;
  [key: `[${string}]`]: LanguageOverrideSettings;
}

export interface VoiceSettings {
  enabled: boolean;
  /** Catalog model id, e.g. "parakeet-tdt-0.6b-v3-int8". */
  sttModel: string;
  dictationMode: "toggle" | "hold";
  /** Electron accelerator, e.g. "CommandOrControl+E". */
  hotkey: string;
  language: string;
  confirmBeforeInsert: boolean;
  /** Apply the developer-term post-processing dictionary to transcripts. */
  dictionaryEnabled?: boolean;
  /** User replacement rules, one per line: "spoken => Replacement". */
  customTerms?: string;
  /** Convert spoken numbers to digits ("three fifty" -> "350"). */
  convertNumbers?: boolean;
}

export const EXTERNAL_APPS = [
  "cursor", "antigravity", "windsurf", "zed", "sublime",
  "xcode", "vscode", "vscode-insiders",
  "intellij", "webstorm", "pycharm", "phpstorm", "rubymine",
  "goland", "clion", "rider", "datagrip", "appcode",
  "fleet", "rustrover", "android-studio",
] as const

export type ExternalApp = (typeof EXTERNAL_APPS)[number]

export const WS_PORT = 9600;
export const WS_PORT_DEV = 9601;

export interface Tab {
  id: string;
  directoryId: string;
  label: string;
  cwd: string;
  sortOrder: number;
  createdAt: number;
  lastAgentType?: string;
  lastAgentSessionId?: string;
  lastAgentState?: AgentState;
  /** True once the user manually renamed this tab; locks auto-naming. */
  userRenamed?: boolean;
  /** True once the session's scope has been manually moved/pinned; suppresses
   *  auto re-pin on cwd change (Follow Agent unchecked). */
  scopePinnedByUser?: boolean;
  launchCommand?: string;
  /** Set when this tab's session was archived; ms epoch of the archive action. */
  archivedAt?: number;
  /** One-shot agent-generated session title. Non-null also means "already
   *  attempted" — this is what freezes it to one title per session. */
  generatedTitle?: string;
  /** Last hook-derived agent display title, persisted so the name survives the
   *  daemon dying (the daemon's own copy is memory-only). Latched: only ever
   *  overwritten by a non-null value — see updateTabPresentationSnapshot. */
  displayTitle?: string;
  /** Derived (never persisted): true when an archived snapshot can be restored. */
  resumeAvailable?: boolean;
}

// --- Archive-session snapshot DTOs ---
// Structural mirror of the daemon's `GridSnapshotDump` (see
// daemon/crates/core/src/types.rs) — renderer-native (packed colors, u32 code
// points), camelCase over the wire. Kept here (not a renderer module) so
// Electron main can read/write archived snapshots without depending on the
// renderer.

export interface GridSnapshotCell {
  cp: number;
  fg: number;
  bg: number;
  flags: number;
  width: number;
  zw?: number[];
  ulColor?: number;
  link?: string;
}
export interface GridSnapshotRow {
  line: number;
  startCol: number;
  cells: GridSnapshotCell[];
  wrapped: boolean;
}
export interface GridSnapshotModes {
  mouseReporting: boolean;
  mouseDrag: boolean;
  mouseMotion: boolean;
  altScreen: boolean;
  appCursor: boolean;
  bracketedPaste: boolean;
}
export interface GridSnapshotDump {
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  totalLines: number;
  base: number;
  cursorShape: "block" | "beam" | "underline" | "hollow" | "hidden";
  cursorBlink: boolean;
  modes: GridSnapshotModes;
  historyRows: GridSnapshotRow[];
  viewport: GridSnapshotRow[];
}
export interface ArchivedSnapshotBlob {
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  capturedAt: number;
  payload: Uint8Array;
}

export interface ReviewComment {
  id: string;
  scopeKey: string;
  source: "sourceControl" | "commit";
  relPath: string;
  staged?: boolean;
  commitSha?: string;
  side: "additions" | "deletions";
  startLine: number;
  endLine: number;
  snippet: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** Identifies which diff a DiffView is showing, so review comments can be
 * scoped to (scope + file + staged/commit). */
export interface ReviewContext {
  scopeKey: string;
  source: "sourceControl" | "commit";
  relPath: string;
  staged?: boolean;
  commitSha?: string;
}

export interface TabSessionRow {
  sessionId: string;
  tabId: string;
  agentType: string;
  workingDir: string;
  createdAt: number;
  lastSeenAt: number;
}

/** A split-layout node. Leaf = one pane (`{ pane: tabId }`); internal node
 *  splits its children horizontally ('h', side-by-side) or vertically ('v',
 *  stacked). `sizes` are percentages parallel to `children`. */
export type LayoutNode =
  | { pane: string }
  | { direction: "h" | "v"; children: LayoutNode[]; sizes: number[] };

/** A group of panes shown as one pill in the tab bar. `layout` is the raw JSON
 *  string as stored in the DB; the store parses it into `LayoutNode`. */
export interface TabGroup {
  id: string;
  directoryId: string;
  sortOrder: number;
  activePaneId?: string;
  layout: string;
  createdAt: number;
}

export type AgentType = "claude" | "codex" | "opencode" | "agy" | "cursor";

export interface AgentLaunchSelection {
  agentType: AgentType;
  modelId: string | null;
  effort: string | null;
  fast: boolean | null;
}

export interface CreateTabOpts {
  directoryId: string;
  label?: string;
  cwd?: string;
  agentLaunch?: AgentLaunchSelection;
}

/** Daemon-canonical agent status sent over the socket. Mirrors the Rust enum
 *  in daemon/crates/core/src/services/detect.rs — exactly these four values.
 *  "done" is NOT a wire value; it is a renderer display state — see
 *  DisplayState in src/lib/agentStatus.ts. */
export type AgentState = "working" | "blocked" | "idle" | "unknown";

export interface TabUpdatedEvent {
  tabId: string;
  agentType?: string | null;
  agentState: AgentState;
  /** Monotonic daemon revision. Missing only for persisted DB fallback data. */
  revision?: number;
  source?: string;
  changedAt?: number;
  lastOutputAt?: number;
  /** Renderer acknowledgement state: completed while this pane was backgrounded. */
  needsAcknowledgement?: boolean;
  lastAgentSessionId?: string;
  /** Latched identity, stamped by Electron main from the DB row (the daemon's
   *  own fields go null when the agent exits). */
  lastAgentType?: string | null;
  /** Derived in main from the latched identity (resume-registry lives there). */
  resumeAvailable?: boolean;
  /** Daemon-resolved agent title, usually a hook-captured user prompt. */
  displayTitle?: string | null;
  /** Name of the current foreground command when no agent owns the tab. */
  foregroundCommand?: string;
  directoryName?: string;
  tabLabel?: string;
}

/** OSC 0 title pushed by the daemon as a running process renames its tab. */
export interface TabTitleEvent {
  tabId: string;
  title: string;
}

/** Emitted once a tab finishes archiving (snapshot durable + PTY confirmed dead). */
export interface TabArchivedEvent {
  tab: Tab;
}

export interface TabUnarchivedEvent {
  tab: Tab;
}
