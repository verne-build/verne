const KEYS = {
  settings: "verne.settings",
  // v2: schema changed from VS Code theme JSON to VerneTheme shape.
  theme: "verne.theme.active.v2",
  panelLeft: "verne.panel.left",
  panelRight: "verne.panel.right",
  panelExplorer: "verne.panel.explorer",
  panelScList: "verne.panel.scList",
  panelCommitsList: "verne.panel.commitsList",
  panelLeftPx: "verne.panel.left.px",
  panelRightPx: "verne.panel.right.px",
  panelExplorerPx: "verne.panel.explorer.px",
  panelScListPx: "verne.panel.scList.px",
  panelCommitsListPx: "verne.panel.commitsList.px",
  panelNotesPx: "verne.panel.notes.px",
  panelSearchPx: "verne.panel.search.px",
  sidebarLeftCollapsed: "verne.sidebar.left.collapsed",
  sidebarRightCollapsed: "verne.sidebar.right.collapsed",
  // workspaces panel height as a fraction (0..1) of the left sidebar; absent = auto-fit
  panelWorkspacesFrac: "verne.panel.workspacesFrac",
  fileExplorerVisible: "verne.fileExplorer.visible",
  scListVisible: "verne.scList.visible",
  commitsListVisible: "verne.commitsList.visible",
} as const;

// One-time migration: panel size key renamed scratchpad→notes.
try {
  const old = localStorage.getItem("verne.panel.scratchpad.px");
  if (old !== null && localStorage.getItem(KEYS.panelNotesPx) === null) {
    localStorage.setItem(KEYS.panelNotesPx, old);
  }
  localStorage.removeItem("verne.panel.scratchpad.px");
} catch { /* private mode / quota — ignore */ }

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / private mode — ignore */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// null = auto-fit (no manual override stored)
export function readCachedWorkspacesFrac(): number | null {
  const n = parseFiniteNumber(safeGet(KEYS.panelWorkspacesFrac));
  if (n === null) return null;
  return Math.min(0.95, Math.max(0.05, n));
}

export function writeCachedWorkspacesFrac(frac: number | null): void {
  if (frac === null) safeRemove(KEYS.panelWorkspacesFrac);
  else safeSet(KEYS.panelWorkspacesFrac, String(frac));
}

export function readCachedSettings(): unknown {
  const raw = safeGet(KEYS.settings);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeCachedSettings(value: unknown): void {
  try {
    safeSet(KEYS.settings, JSON.stringify(value));
  } catch {
    /* circular / un-serializable — ignore */
  }
}

export interface CachedTheme {
  name: string;
  theme: unknown;
}

export function readCachedTheme(): CachedTheme | null {
  const raw = safeGet(KEYS.theme);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.name === "string" && parsed.theme) {
      return parsed as CachedTheme;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCachedTheme(theme: CachedTheme): void {
  try {
    safeSet(KEYS.theme, JSON.stringify(theme));
  } catch {
    /* circular / un-serializable — ignore */
  }
}

export interface CachedPanelState {
  left: number | null;
  right: number | null;
  explorer: number | null;
  scList: number | null;
  commitsList: number | null;
  leftPx: number | null;
  rightPx: number | null;
  explorerPx: number | null;
  scListPx: number | null;
  commitsListPx: number | null;
  notesPx: number | null;
  searchPx: number | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  fileExplorerVisible: boolean;
  scListVisible: boolean;
  commitsListVisible: boolean;
}

function parseFiniteNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function readCachedPanelState(): CachedPanelState {
  return {
    left: parseFiniteNumber(safeGet(KEYS.panelLeft)),
    right: parseFiniteNumber(safeGet(KEYS.panelRight)),
    explorer: parseFiniteNumber(safeGet(KEYS.panelExplorer)),
    scList: parseFiniteNumber(safeGet(KEYS.panelScList)),
    commitsList: parseFiniteNumber(safeGet(KEYS.panelCommitsList)),
    leftPx: parseFiniteNumber(safeGet(KEYS.panelLeftPx)),
    rightPx: parseFiniteNumber(safeGet(KEYS.panelRightPx)),
    explorerPx: parseFiniteNumber(safeGet(KEYS.panelExplorerPx)),
    scListPx: parseFiniteNumber(safeGet(KEYS.panelScListPx)),
    commitsListPx: parseFiniteNumber(safeGet(KEYS.panelCommitsListPx)),
    notesPx: parseFiniteNumber(safeGet(KEYS.panelNotesPx)),
    searchPx: parseFiniteNumber(safeGet(KEYS.panelSearchPx)),
    leftCollapsed: safeGet(KEYS.sidebarLeftCollapsed) === "true",
    // Right panel defaults to collapsed (only open once explicitly stored "false").
    rightCollapsed: safeGet(KEYS.sidebarRightCollapsed) !== "false",
    fileExplorerVisible: safeGet(KEYS.fileExplorerVisible) === "true",
    scListVisible: safeGet(KEYS.scListVisible) !== "false",
    commitsListVisible: safeGet(KEYS.commitsListVisible) !== "false",
  };
}

export function writeCachedPanelSize(
  which: "left" | "right" | "explorer" | "scList" | "commitsList",
  value: number,
): void {
  const key =
    which === "left" ? KEYS.panelLeft :
    which === "right" ? KEYS.panelRight :
    which === "explorer" ? KEYS.panelExplorer :
    which === "scList" ? KEYS.panelScList :
    KEYS.panelCommitsList;
  safeSet(key, String(value));
}

export function writeCachedPanelPx(
  which: "left" | "right" | "explorer" | "scList" | "commitsList" | "notes" | "search",
  value: number,
): void {
  const key =
    which === "left" ? KEYS.panelLeftPx :
    which === "right" ? KEYS.panelRightPx :
    which === "explorer" ? KEYS.panelExplorerPx :
    which === "scList" ? KEYS.panelScListPx :
    which === "commitsList" ? KEYS.panelCommitsListPx :
    which === "notes" ? KEYS.panelNotesPx :
    KEYS.panelSearchPx;
  safeSet(key, String(Math.round(value)));
}

// Drop every cached panel *size* (widths + workspaces fraction). Leaves
// collapse/visibility state intact so reset only restores sizes, not layout.
export function clearCachedPanelSizes(): void {
  for (const key of [
    KEYS.panelLeft, KEYS.panelRight, KEYS.panelExplorer, KEYS.panelScList, KEYS.panelCommitsList,
    KEYS.panelLeftPx, KEYS.panelRightPx, KEYS.panelExplorerPx, KEYS.panelScListPx, KEYS.panelCommitsListPx,
    KEYS.panelNotesPx, KEYS.panelSearchPx, KEYS.panelWorkspacesFrac,
  ]) safeRemove(key);
}

export function writeCachedSidebarCollapsed(which: "left" | "right", collapsed: boolean): void {
  const key = which === "left" ? KEYS.sidebarLeftCollapsed : KEYS.sidebarRightCollapsed;
  safeSet(key, collapsed ? "true" : "false");
}

export function writeCachedFileExplorerVisible(visible: boolean): void {
  safeSet(KEYS.fileExplorerVisible, visible ? "true" : "false");
}

export function writeCachedScListVisible(visible: boolean): void {
  safeSet(KEYS.scListVisible, visible ? "true" : "false");
}

export function writeCachedCommitsListVisible(visible: boolean): void {
  safeSet(KEYS.commitsListVisible, visible ? "true" : "false");
}
