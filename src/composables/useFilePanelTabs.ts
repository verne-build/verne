import { computed, triggerRef, shallowRef, watch } from "vue";
import type {
  FilePanelTab, FilePanelFileTab,
  FilePanelSourceControlTab, FilePanelCommitsTab, FilePanelExplorerTab,
  FilePanelNotesTab, FilePanelSearchTab, FilePanelNewTab, FilePanelBrowserTab, SidebarTabRow,
} from "@/types";
import { SC_TAB_ID, COMMITS_TAB_ID, EXPLORER_TAB_ID, NOTES_TAB_ID, SEARCH_TAB_ID, NEW_TAB_ID } from "@/types";
import { normalizeBrowserUrl, labelForUrl } from "@/lib/browserTabs";
import { reorderById } from "@/lib/reorderTabs";
import { useRpc } from "./useRpc";

export interface ScSelection {
  relPath: string;
  staged: boolean;
  original: string;
  modified: string;
}

export interface CommitsSelection {
  relPath: string;
  commitId: string;
  commitShortId: string;
  original: string;
  modified: string;
}

interface DirState {
  fileTabs: FilePanelFileTab[];
  browserTabs: FilePanelBrowserTab[];
  scSelection: ScSelection | null;
  commitsSelection: CommitsSelection | null;
  activeId: string | null;
  // Activation history (most-recent-last) so closing the active tab falls back
  // to the previously-active tab, not the last tab in the list.
  activationHistory: string[];
  rightSidebarView: string;
}

export type FpScope = { path: string; scopeType: "directory" | "agent_worktree"; scopeId: string };

function scopeKey(s: FpScope): string {
  return `${s.scopeType}:${s.scopeId}`;
}

const dirState = shallowRef(new Map<string, DirState>());
const dirtyFiles = new Set<string>();
const dirtyVersion = shallowRef(0);
const loaded = new Set<string>();
const loadComplete = new Set<string>();

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Recently-closed file tabs (most-recent-last), per scope, for ⌘⇧T reopen.
interface ClosedTab { key: string; filePath: string; cursorLine?: number; cursorColumn?: number }
const closedTabStack: ClosedTab[] = [];
const CLOSED_STACK_MAX = 25;

function trigger() { triggerRef(dirState); }

function triggerDirty() {
  dirtyVersion.value++;
}

function makeDefault(): DirState {
  return { fileTabs: [], browserTabs: [], scSelection: null, commitsSelection: null, activeId: null, activationHistory: [], rightSidebarView: "sc" };
}

function recordActivation(s: DirState, id: string | null) {
  if (!id) return;
  const i = s.activationHistory.indexOf(id);
  if (i !== -1) s.activationHistory.splice(i, 1);
  s.activationHistory.push(id);
}

function getOrCreate(key: string): DirState {
  if (!dirState.value.has(key)) dirState.value.set(key, makeDefault());
  return dirState.value.get(key)!;
}

const SC_TAB: FilePanelSourceControlTab = { kind: "sourceControl", id: SC_TAB_ID };
const COMMITS_TAB: FilePanelCommitsTab = { kind: "commits", id: COMMITS_TAB_ID };
const EXPLORER_TAB: FilePanelExplorerTab = { kind: "explorer", id: EXPLORER_TAB_ID };
const NOTES_TAB: FilePanelNotesTab = { kind: "notes", id: NOTES_TAB_ID };
const SEARCH_TAB: FilePanelSearchTab = { kind: "search", id: SEARCH_TAB_ID };
const NEW_TAB: FilePanelNewTab = { kind: "newTab", id: NEW_TAB_ID };

function isSyntheticId(id: string | null): id is typeof SC_TAB_ID | typeof COMMITS_TAB_ID | typeof EXPLORER_TAB_ID | typeof NOTES_TAB_ID | typeof SEARCH_TAB_ID | typeof NEW_TAB_ID {
  return id === SC_TAB_ID || id === COMMITS_TAB_ID || id === EXPLORER_TAB_ID || id === NOTES_TAB_ID || id === SEARCH_TAB_ID || id === NEW_TAB_ID;
}

function rowToFileTab(row: SidebarTabRow): FilePanelFileTab {
  return {
    kind: "file",
    id: row.tabId,
    filePath: row.tabId,
    label: row.label,
    cursorLine: row.cursorLine,
    cursorColumn: row.cursorColumn,
    scrollTop: row.scrollTop,
  };
}

function fileTabToRow(t: FilePanelFileTab, scopeId: string, position: number): SidebarTabRow {
  return {
    directoryId: scopeId,
    tabId: t.id,
    tabType: "file",
    label: t.label,
    position,
    cursorLine: t.cursorLine,
    cursorColumn: t.cursorColumn,
    scrollTop: t.scrollTop,
  };
}

function debouncedSave(scope: FpScope, state: DirState) {
  const key = scopeKey(scope);
  if (!loadComplete.has(key)) return;
  const existing = saveTimers.get(key);
  if (existing) clearTimeout(existing);
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    const fileRows = state.fileTabs.map((t, i) => fileTabToRow(t, scope.scopeId, i));
    const offset = fileRows.length;
    const browserRows: SidebarTabRow[] = state.browserTabs.map((t, i) => ({
      directoryId: scope.scopeId,
      tabId: t.id,
      tabType: "browser" as const,
      label: t.label,
      position: offset + i,
      browserUrl: t.browserUrl,
      pinned: !!t.pinned,
    }));
    const rows = [...fileRows, ...browserRows];
    const persistedIds = new Set(rows.map(r => r.tabId));
    const fileActive = state.activeId && (persistedIds.has(state.activeId) || isSyntheticId(state.activeId))
      ? state.activeId
      : null;
    useRpc().request.saveSidebarTabs({
      directoryId: scope.scopeId,
      scopeType: scope.scopeType,
      tabs: rows,
      activeTabId: state.rightSidebarView,
      listColumnWidth: 250,
      rightSidebarView: state.rightSidebarView,
      filePanelActiveId: fileActive,
    }).catch(() => {});
  }, 500));
}

/// Update a browser tab's mutable metadata (label, faviconUrl, browserUrl)
/// across all scopes. Triggers reactivity and persists whichever scope owns the tab.
export function updateBrowserTab(id: string, patch: { label?: string; faviconUrl?: string; browserUrl?: string }) {
  for (const [key, state] of dirState.value.entries()) {
    const tab = state.browserTabs.find(t => t.id === id);
    if (!tab) continue;
    if (patch.label !== undefined) tab.label = patch.label;
    if (patch.faviconUrl !== undefined) tab.faviconUrl = patch.faviconUrl;
    if (patch.browserUrl !== undefined) tab.browserUrl = patch.browserUrl;
    trigger();
    const sep = key.indexOf(":");
    if (sep > 0) {
      const scopeType = key.slice(0, sep) as FpScope["scopeType"];
      const scopeId = key.slice(sep + 1);
      debouncedSave({ path: "", scopeType, scopeId }, state);
    }
    return;
  }
}

/// Evict all per-scope state for a removed directory/worktree so the module's
/// maps don't leak entries for the rest of the session. Called from the
/// workspace store when a directory or worktree is deleted. `scopeId` is the
/// directory id; both possible scope types are cleared.
export function dropFilePanelScope(scopeId: string) {
  let changed = false;
  let dirtyChanged = false;
  for (const scopeType of ["directory", "agent_worktree"] as const) {
    const key = `${scopeType}:${scopeId}`;
    const timer = saveTimers.get(key);
    if (timer) { clearTimeout(timer); saveTimers.delete(key); }
    loaded.delete(key);
    loadComplete.delete(key);
    const state = dirState.value.get(key);
    if (state) {
      for (const t of state.fileTabs) {
        if (dirtyFiles.delete(t.filePath)) dirtyChanged = true;
      }
      // Browser tabs: the DOM <webview> unmounts with the panel and Chromium
      // destroys the WebContents automatically — no explicit close needed.
      dirState.value.delete(key);
      changed = true;
    }
  }
  if (changed) trigger();
  if (dirtyChanged) triggerDirty();
}

export async function ensureFilePanelLoaded(scope: FpScope) {
  const key = scopeKey(scope);
  if (loaded.has(key)) return;
  loaded.add(key);
  try {
    const { request } = useRpc();
    const [rows, sidebarState] = await Promise.all([
      request.getSidebarTabs({ directoryId: scope.scopeId, scopeType: scope.scopeType }),
      request.getSidebarState({ directoryId: scope.scopeId, scopeType: scope.scopeType }),
    ]);
    const sortedRows = [...rows].sort((a, b) => a.position - b.position);
    const fileTabs = sortedRows.filter(r => r.tabType === "file").map(rowToFileTab);
    const browserTabs: FilePanelBrowserTab[] = sortedRows
      .filter(r => r.tabType === "browser" && r.browserUrl)
      .map(r => ({
        kind: "browser" as const,
        id: r.tabId,
        label: r.label,
        browserUrl: r.browserUrl!,
        pinned: r.pinned,
      }));

    let rightView = sidebarState?.rightSidebarView;
    let activeId = sidebarState?.filePanelActiveId ?? null;
    if (!rightView) {
      const legacy = sidebarState?.activeTabId;
      if (legacy === "sc" || legacy === "commits" || legacy === "browser" || legacy === "files") {
        rightView = legacy;
      } else if (legacy && fileTabs.some(t => t.id === legacy)) {
        rightView = "sc";
        if (!activeId) activeId = legacy;
      } else {
        rightView = "sc";
      }
    }
    const allTabIds = new Set<string>([...fileTabs.map(t => t.id), ...browserTabs.map(t => t.id)]);
    if (activeId === EXPLORER_TAB_ID && fileTabs.length > 0) activeId = null;
    if (activeId && !isSyntheticId(activeId) && !allTabIds.has(activeId)) activeId = null;
    if (!activeId) activeId = SC_TAB_ID;

    dirState.value.set(key, {
      fileTabs,
      browserTabs,
      scSelection: null,
      commitsSelection: null,
      activeId,
      activationHistory: activeId ? [activeId] : [],
      rightSidebarView: rightView ?? "sc",
    });
    trigger();
    loadComplete.add(key);
  } catch {
    loaded.delete(key);
  }
}

export function syncFilePanelFilePath(oldPath: string, newPath: string) {
  const newLabel = newPath.split("/").pop() || newPath;
  for (const [key, state] of dirState.value.entries()) {
    const idx = state.fileTabs.findIndex(t => t.filePath === oldPath);
    if (idx === -1) continue;
    state.fileTabs = state.fileTabs.map((t, i) =>
      i === idx ? { ...t, id: newPath, filePath: newPath, label: newLabel } : t,
    );
    if (state.activeId === oldPath) state.activeId = newPath;
    const hIdx = state.activationHistory.indexOf(oldPath);
    if (hIdx !== -1) state.activationHistory[hIdx] = newPath;
    if (dirtyFiles.has(oldPath)) {
      dirtyFiles.delete(oldPath);
      dirtyFiles.add(newPath);
      triggerDirty();
    }
    trigger();
    const sep = key.indexOf(":");
    if (sep > 0) {
      const scopeType = key.slice(0, sep) as FpScope["scopeType"];
      const scopeId = key.slice(sep + 1);
      debouncedSave({ path: "", scopeType, scopeId }, state);
    }
  }
}

export function useFilePanelTabs(scope: () => FpScope | null) {
  const { request } = useRpc();

  watch(
    () => scope(),
    (s) => { if (s) ensureFilePanelLoaded(s); },
    { immediate: true, deep: true },
  );

  function resolve(): DirState | null {
    const s = scope();
    if (!s) return null;
    return getOrCreate(scopeKey(s));
  }

  function persist() {
    const s = scope();
    const state = resolve();
    if (s && state) debouncedSave(s, state);
  }

  const fileTabs = computed<FilePanelFileTab[]>(() => {
    dirState.value;
    return resolve()?.fileTabs ?? [];
  });

  const scSelection = computed<ScSelection | null>(() => {
    dirState.value;
    return resolve()?.scSelection ?? null;
  });

  const commitsSelection = computed<CommitsSelection | null>(() => {
    dirState.value;
    return resolve()?.commitsSelection ?? null;
  });

  const allTabs = computed<FilePanelTab[]>(() => {
    dirState.value;
    const s = resolve();
    const sc = scope();
    if (!s || !sc) return [];
    return [
      SC_TAB,
      COMMITS_TAB,
      SEARCH_TAB,
      NOTES_TAB,
      NEW_TAB,
      ...(s.fileTabs.length === 0 ? [EXPLORER_TAB] : []),
      ...s.fileTabs,
      ...s.browserTabs,
    ];
  });

  const activeId = computed<string | null>(() => {
    dirState.value;
    return resolve()?.activeId ?? null;
  });

  const activeTab = computed<FilePanelTab | null>(() => {
    const id = activeId.value;
    if (!id) return null;
    return allTabs.value.find(t => t.id === id) ?? null;
  });

  const isMounted = computed(() => allTabs.value.length > 0);

  function setActiveId(id: string) {
    const s = resolve();
    if (!s) return;
    s.activeId = id;
    recordActivation(s, id);
    trigger();
    persist();
  }

  // opts.permanent: open a pinned (non-preview) tab — explorer double-click,
  // Enter, quick-open, reveal. Default (false) opens a preview tab that reuses
  // the single ephemeral slot.
  function openFile(filePath: string, position?: { line: number; column: number }, opts?: { permanent?: boolean }) {
    const sc = scope();
    const s = resolve();
    if (!s || !sc) return;
    const label = filePath.split("/").pop() || filePath;
    const existing = s.fileTabs.find(t => t.filePath === filePath);
    if (existing) {
      if (position) {
        existing.cursorLine = position.line;
        existing.cursorColumn = position.column;
        existing.scrollTop = undefined;
        existing.positionVersion = (existing.positionVersion ?? 0) + 1;
      }
      if (opts?.permanent) existing.ephemeral = false;
      s.activeId = existing.id;
      recordActivation(s, existing.id);
    } else {
      const tab: FilePanelFileTab = {
        kind: "file",
        id: filePath,
        filePath,
        label,
        cursorLine: position?.line,
        cursorColumn: position?.column,
        ephemeral: !opts?.permanent,
      };
      // Preview opens replace the current ephemeral file tab in place (reuse the
      // slot). Ephemeral tabs are never dirty (promoted on first edit), so no
      // unsaved work is lost.
      const slotIdx = tab.ephemeral ? s.fileTabs.findIndex(t => t.ephemeral) : -1;
      if (slotIdx !== -1) {
        const prevId = s.fileTabs[slotIdx].id;
        const hi = s.activationHistory.indexOf(prevId);
        if (hi !== -1) s.activationHistory.splice(hi, 1);
        const next = [...s.fileTabs];
        next.splice(slotIdx, 1, tab);
        s.fileTabs = next;
      } else {
        s.fileTabs = [...s.fileTabs, tab];
      }
      s.activeId = tab.id;
      recordActivation(s, tab.id);
    }
    trigger();
    persist();
    request.touchRecentFile({ directoryId: sc.scopeId, scopeType: sc.scopeType, path: filePath }).catch(() => {});
  }

  // Promote a preview (file or diff) tab to a permanent one. No-op if already
  // permanent or not found.
  function promoteTab(id: string) {
    const s = resolve();
    if (!s) return;
    const f = s.fileTabs.find(t => t.id === id);
    if (f?.ephemeral) { f.ephemeral = false; trigger(); persist(); }
  }

  function openBrowserTab(rawUrl: string, label?: string, id?: string): string {
    const s = resolve();
    if (!s) return "";
    const url = normalizeBrowserUrl(rawUrl);
    // Always create a fresh tab when no explicit id is given. Explicit ids
    // (agent-opened tabs) use the provided id as-is.
    const tabId = id ?? `browser:${crypto.randomUUID()}`;
    const tab: FilePanelBrowserTab = {
      kind: "browser",
      id: tabId,
      label: label || labelForUrl(url),
      browserUrl: url,
    };
    s.browserTabs = [...s.browserTabs, tab];
    s.activeId = tabId;
    recordActivation(s, tabId);
    trigger();
    persist();
    return tabId;
  }

  function closeTab(id: string) {
    if (isSyntheticId(id)) return;
    const sc = scope();
    const s = resolve();
    if (!s) return;
    const fileIdx = s.fileTabs.findIndex(t => t.id === id);
    if (fileIdx !== -1) {
      if (sc) {
        const closed = s.fileTabs[fileIdx];
        closedTabStack.push({
          key: scopeKey(sc),
          filePath: closed.filePath,
          cursorLine: closed.cursorLine,
          cursorColumn: closed.cursorColumn,
        });
        if (closedTabStack.length > CLOSED_STACK_MAX) closedTabStack.shift();
      }
      const next = [...s.fileTabs];
      next.splice(fileIdx, 1);
      s.fileTabs = next;
      if (dirtyFiles.delete(id)) triggerDirty();
    } else {
      const bIdx = s.browserTabs.findIndex(t => t.id === id);
      if (bIdx === -1) return;
      const nextBrowser = [...s.browserTabs];
      nextBrowser.splice(bIdx, 1);
      s.browserTabs = nextBrowser;
    }
    const hi = s.activationHistory.indexOf(id);
    if (hi !== -1) s.activationHistory.splice(hi, 1);
    if (s.activeId === id) {
      // Fall back to the most-recent still-live tab, else the last remaining, else SC.
      const remaining = [...s.fileTabs, ...s.browserTabs];
      const live = new Set(remaining.map(t => t.id));
      let nextId: string | undefined;
      for (let i = s.activationHistory.length - 1; i >= 0; i--) {
        if (live.has(s.activationHistory[i])) { nextId = s.activationHistory[i]; break; }
      }
      s.activeId = nextId ?? (remaining.length > 0 ? remaining[remaining.length - 1].id : SC_TAB_ID);
    }
    trigger();
    persist();
  }

  // Reopen the most-recently-closed file tab for the current scope (⌘⇧T).
  function reopenLastClosed() {
    const sc = scope();
    if (!sc) return;
    const key = scopeKey(sc);
    for (let i = closedTabStack.length - 1; i >= 0; i--) {
      if (closedTabStack[i].key !== key) continue;
      const [entry] = closedTabStack.splice(i, 1);
      openFile(
        entry.filePath,
        entry.cursorLine ? { line: entry.cursorLine, column: entry.cursorColumn ?? 1 } : undefined,
      );
      return;
    }
  }

  function setScSelection(sel: ScSelection | null) {
    const s = resolve();
    if (!s) return;
    s.scSelection = sel;
    trigger();
  }

  function setCommitsSelection(sel: CommitsSelection | null) {
    const s = resolve();
    if (!s) return;
    s.commitsSelection = sel;
    trigger();
  }

  function updateTabViewState(id: string, view: { scrollTop?: number; cursorLine?: number; cursorColumn?: number }) {
    const s = resolve();
    if (!s) return;
    const t = s.fileTabs.find(x => x.id === id);
    if (!t) return;
    t.scrollTop = view.scrollTop;
    t.cursorLine = view.cursorLine;
    t.cursorColumn = view.cursorColumn;
    persist();
  }

  function reorderTabs(ids: string[]) {
    const s = resolve();
    if (!s) return;
    const next = reorderById(s.fileTabs, ids);
    if (!next) return; // id subset doesn't cover all file tabs → no change
    s.fileTabs = next;
    trigger();
    persist();
  }

  function reorderBrowserTabs(ids: string[]) {
    const s = resolve();
    if (!s) return;
    const next = reorderById(s.browserTabs, ids);
    if (!next) return; // id subset doesn't cover all browser tabs → no change
    s.browserTabs = next;
    trigger();
    persist();
  }

  function setFileDirty(filePath: string, isDirty: boolean) {
    if (!filePath) return;
    const wasDirty = dirtyFiles.has(filePath);
    if (isDirty) dirtyFiles.add(filePath);
    else dirtyFiles.delete(filePath);
    if (wasDirty !== isDirty) triggerDirty();
    // First edit promotes a preview tab to permanent (VS Code behaviour).
    if (isDirty) {
      const s = resolve();
      const t = s?.fileTabs.find(t => t.filePath === filePath);
      if (t?.ephemeral) { t.ephemeral = false; trigger(); }
    }
    persist();
  }

  function isFileDirty(filePath: string): boolean {
    dirtyVersion.value;
    return dirtyFiles.has(filePath);
  }

  return {
    fileTabs,
    scSelection,
    commitsSelection,
    allTabs,
    activeId,
    activeTab,
    isMounted,
    setActiveId,
    openFile,
    openBrowserTab,
    promoteTab,
    closeTab,
    reopenLastClosed,
    setScSelection,
    setCommitsSelection,
    reorderTabs,
    reorderBrowserTabs,
    updateTabViewState,
    setFileDirty,
    isFileDirty,
  };
}
