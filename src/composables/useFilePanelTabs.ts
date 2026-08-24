import { computed, shallowRef, triggerRef, watch } from "vue";
import type { FilePanelBrowserTab, FilePanelFileTab, FilePanelTab, OpenableTabKind } from "@/types";
import { COMMITS_TAB_ID, NOTES_TAB_ID, SC_TAB_ID, SEARCH_TAB_ID } from "@/types";
import { labelForUrl, normalizeBrowserUrl } from "@/lib/browserTabs";
import { reorderById } from "@/lib/reorderTabs";
import {
  debouncedSave,
  dropFilePanelPersistence,
  ensureFilePanelLoaded as loadPersistedFilePanel,
} from "./filePanelPersistence";
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
  tabs: FilePanelTab[];
  scSelection: ScSelection | null;
  commitsSelection: CommitsSelection | null;
  activeId: string | null;
  // Activation history is most-recent-last.
  activationHistory: string[];
  hydration: "idle" | "loading" | "loaded";
  hydrationPromise: Promise<void> | null;
  pendingPersistence: boolean;
  pendingActivation: boolean;
  pendingClosedIds: Set<string>;
}

export type FpScope = { path: string; scopeType: "directory" | "agent_worktree"; scopeId: string };

const SINGLETON_IDS = {
  sourceControl: SC_TAB_ID,
  commits: COMMITS_TAB_ID,
  search: SEARCH_TAB_ID,
  notes: NOTES_TAB_ID,
} as const;

const dirState = shallowRef(new Map<string, DirState>());
const dirtyFiles = new Set<string>();
const dirtyVersion = shallowRef(0);

// Recently-closed file tabs (most-recent-last), per scope, for ⌘⇧T reopen.
interface ClosedTab { key: string; filePath: string; cursorLine?: number; cursorColumn?: number }
const closedTabStack: ClosedTab[] = [];
const CLOSED_STACK_MAX = 25;

function scopeKey(scope: FpScope): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

function makeDefault(): DirState {
  return {
    tabs: [],
    scSelection: null,
    commitsSelection: null,
    activeId: null,
    activationHistory: [],
    hydration: "idle",
    hydrationPromise: null,
    pendingPersistence: false,
    pendingActivation: false,
    pendingClosedIds: new Set(),
  };
}

function trigger(): void {
  triggerRef(dirState);
}

function triggerDirty(): void {
  dirtyVersion.value++;
}

function recordActivation(state: DirState, id: string | null): void {
  if (!id) return;
  const index = state.activationHistory.indexOf(id);
  if (index !== -1) state.activationHistory.splice(index, 1);
  state.activationHistory.push(id);
}

function activate(state: DirState, id: string): void {
  state.activeId = id;
  if (state.hydration !== "loaded") state.pendingActivation = true;
  recordActivation(state, id);
}

function getOrCreate(key: string): DirState {
  if (!dirState.value.has(key)) dirState.value.set(key, makeDefault());
  return dirState.value.get(key)!;
}

function scopeFromKey(key: string): FpScope | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  return {
    path: "",
    scopeType: key.slice(0, separator) as FpScope["scopeType"],
    scopeId: key.slice(separator + 1),
  };
}

function makeTabOfKind(kind: OpenableTabKind, id: string): FilePanelTab {
  switch (kind) {
    case "sourceControl": return { kind, id: SC_TAB_ID };
    case "commits": return { kind, id: COMMITS_TAB_ID };
    case "search": return { kind, id: SEARCH_TAB_ID };
    case "notes": return { kind, id: NOTES_TAB_ID };
    case "explorer": return { kind, id };
    case "browser": return { kind, id, label: "New Tab", browserUrl: null };
  }
}

export function updateBrowserTab(
  id: string,
  patch: { label?: string; faviconUrl?: string; browserUrl?: string | null },
): void {
  for (const [key, state] of dirState.value.entries()) {
    const tab = state.tabs.find(
      (candidate): candidate is FilePanelBrowserTab => candidate.kind === "browser" && candidate.id === id,
    );
    if (!tab) continue;
    if (patch.label !== undefined) tab.label = patch.label;
    if (patch.faviconUrl !== undefined) tab.faviconUrl = patch.faviconUrl;
    if (patch.browserUrl !== undefined) tab.browserUrl = patch.browserUrl;
    trigger();
    const scope = scopeFromKey(key);
    if (scope) {
      if (state.hydration === "loaded") debouncedSave(scope, state.tabs, state.activeId);
      else state.pendingPersistence = true;
    }
    return;
  }
}

export function dropFilePanelScope(scopeId: string): void {
  let changed = false;
  let dirtyChanged = false;
  for (const scopeType of ["directory", "agent_worktree"] as const) {
    const key = `${scopeType}:${scopeId}`;
    for (let index = closedTabStack.length - 1; index >= 0; index--) {
      if (closedTabStack[index].key === key) closedTabStack.splice(index, 1);
    }
    const state = dirState.value.get(key);
    if (!state) continue;
    for (const tab of state.tabs) {
      if (tab.kind === "file" && dirtyFiles.delete(tab.filePath)) dirtyChanged = true;
    }
    dirState.value.delete(key);
    changed = true;
  }
  dropFilePanelPersistence(scopeId);
  if (changed) trigger();
  if (dirtyChanged) triggerDirty();
}

function mergeHydratedTabs(
  persisted: FilePanelTab[],
  pending: FilePanelTab[],
  pendingClosedIds: ReadonlySet<string>,
): FilePanelTab[] {
  const pendingById = new Map(pending.map((tab) => [tab.id, tab]));
  const merged = persisted.filter((tab) => !pendingClosedIds.has(tab.id)).map((tab) => {
    const local = pendingById.get(tab.id);
    if (!local) return tab;
    pendingById.delete(tab.id);
    if (local.kind !== tab.kind) return local;
    const definedLocal = Object.fromEntries(
      Object.entries(local).filter(([, value]) => value !== undefined),
    );
    return { ...tab, ...definedLocal } as FilePanelTab;
  });
  return [...merged, ...pending.filter((tab) => pendingById.has(tab.id))];
}

export function ensureFilePanelLoaded(scope: FpScope): Promise<void> {
  const key = scopeKey(scope);
  const state = getOrCreate(key);
  if (state.hydration === "loaded") return Promise.resolve();
  if (state.hydration === "loading" && state.hydrationPromise) return state.hydrationPromise;

  state.hydration = "loading";
  const hydration = (async () => {
    const loaded = await loadPersistedFilePanel(scope);
    if (dirState.value.get(key) !== state) return;
    if (!loaded) {
      state.hydration = "idle";
      state.hydrationPromise = null;
      return;
    }

    const pendingTabs = state.tabs;
    const pendingActiveId = state.activeId;
    const pendingActivation = state.pendingActivation;
    const needsSave = state.pendingPersistence || loaded.needsSave;
    state.tabs = mergeHydratedTabs(loaded.tabs, pendingTabs, state.pendingClosedIds);
    const liveIds = new Set(state.tabs.map((tab) => tab.id));
    const preferredActive = pendingActivation && pendingActiveId && liveIds.has(pendingActiveId)
      ? pendingActiveId
      : loaded.activeId;
    state.activeId = preferredActive && liveIds.has(preferredActive)
      ? preferredActive
      : state.tabs[0]?.id ?? null;
    state.activationHistory = [
      ...state.activationHistory.filter((id) => liveIds.has(id) && id !== state.activeId),
      ...(state.activeId ? [state.activeId] : []),
    ];
    state.hydration = "loaded";
    state.hydrationPromise = null;
    state.pendingPersistence = false;
    state.pendingActivation = false;
    state.pendingClosedIds.clear();
    trigger();
    if (needsSave) debouncedSave(scope, state.tabs, state.activeId);
  })();
  state.hydrationPromise = hydration;
  return hydration;
}

export function syncFilePanelFilePath(oldPath: string, newPath: string): void {
  const newLabel = newPath.split("/").pop() || newPath;
  for (const [key, state] of dirState.value.entries()) {
    const index = state.tabs.findIndex((tab) => tab.kind === "file" && tab.filePath === oldPath);
    if (index === -1) continue;
    const destinationIndex = state.tabs.findIndex(
      (tab, tabIndex) => tabIndex !== index && tab.kind === "file" && tab.filePath === newPath,
    );
    if (destinationIndex === -1) {
      state.tabs = state.tabs.map((tab, tabIndex) =>
        tabIndex === index && tab.kind === "file"
          ? { ...tab, id: newPath, filePath: newPath, label: newLabel }
          : tab,
      );
    } else {
      state.tabs = state.tabs.filter((_, tabIndex) => tabIndex !== index);
    }
    if (state.activeId === oldPath) state.activeId = newPath;
    const remappedHistory = state.activationHistory.map((id) => id === oldPath ? newPath : id);
    state.activationHistory = remappedHistory.filter(
      (id, historyIndex) => remappedHistory.lastIndexOf(id) === historyIndex,
    );
    if (dirtyFiles.has(oldPath)) {
      dirtyFiles.delete(oldPath);
      dirtyFiles.add(newPath);
      triggerDirty();
    }
    trigger();
    const scope = scopeFromKey(key);
    if (scope) {
      if (state.hydration === "loaded") debouncedSave(scope, state.tabs, state.activeId);
      else {
        state.pendingClosedIds.add(oldPath);
        state.pendingClosedIds.delete(newPath);
        state.pendingPersistence = true;
      }
    }
  }
}

export function useFilePanelTabs(scope: () => FpScope | null) {
  const { request } = useRpc();

  watch(
    () => scope(),
    (nextScope) => { if (nextScope) void ensureFilePanelLoaded(nextScope); },
    { immediate: true, deep: true },
  );

  function resolve(): DirState | null {
    const currentScope = scope();
    return currentScope ? getOrCreate(scopeKey(currentScope)) : null;
  }

  function persist(): void {
    const currentScope = scope();
    const state = resolve();
    if (!currentScope || !state) return;
    if (state.hydration !== "loaded") {
      state.pendingPersistence = true;
      return;
    }
    debouncedSave(currentScope, state.tabs, state.activeId);
  }

  function triggerAndPersist(): void {
    trigger();
    persist();
  }

  const tabs = computed<FilePanelTab[]>(() => {
    dirState.value;
    return resolve()?.tabs ?? [];
  });

  const scSelection = computed<ScSelection | null>(() => {
    dirState.value;
    return resolve()?.scSelection ?? null;
  });

  const commitsSelection = computed<CommitsSelection | null>(() => {
    dirState.value;
    return resolve()?.commitsSelection ?? null;
  });

  const activeId = computed<string | null>(() => {
    dirState.value;
    return resolve()?.activeId ?? null;
  });

  const activeTab = computed<FilePanelTab | null>(() => {
    const id = activeId.value;
    return id ? tabs.value.find((tab) => tab.id === id) ?? null : null;
  });

  const isMounted = computed(() => tabs.value.length > 0);

  function setActiveId(id: string): void {
    const state = resolve();
    if (!state?.tabs.some((tab) => tab.id === id)) return;
    activate(state, id);
    triggerAndPersist();
  }

  function openTabOfKind(kind: OpenableTabKind): string {
    const state = resolve();
    if (!state) return "";
    const singletonId = kind in SINGLETON_IDS
      ? SINGLETON_IDS[kind as keyof typeof SINGLETON_IDS]
      : null;
    if (singletonId) state.pendingClosedIds.delete(singletonId);
    if (singletonId && state.tabs.some((tab) => tab.id === singletonId)) {
      activate(state, singletonId);
      triggerAndPersist();
      return singletonId;
    }

    const id = singletonId ?? `${kind}:${crypto.randomUUID()}`;
    state.pendingClosedIds.delete(id);
    state.tabs = [...state.tabs, makeTabOfKind(kind, id)];
    activate(state, id);
    triggerAndPersist();
    return id;
  }

  // opts.permanent opens a pinned tab. Preview tabs reuse one exact array slot.
  function openFile(
    filePath: string,
    position?: { line: number; column: number },
    opts?: { permanent?: boolean },
  ): void {
    const currentScope = scope();
    const state = resolve();
    if (!state || !currentScope) return;
    state.pendingClosedIds.delete(filePath);
    const existing = state.tabs.find(
      (tab): tab is FilePanelFileTab => tab.kind === "file" && tab.filePath === filePath,
    );
    if (existing) {
      if (position) {
        existing.cursorLine = position.line;
        existing.cursorColumn = position.column;
        existing.scrollTop = undefined;
        existing.positionVersion = (existing.positionVersion ?? 0) + 1;
      }
      if (opts?.permanent) existing.ephemeral = false;
      activate(state, existing.id);
    } else {
      const tab: FilePanelFileTab = {
        kind: "file",
        id: filePath,
        filePath,
        label: filePath.split("/").pop() || filePath,
        cursorLine: position?.line,
        cursorColumn: position?.column,
        ephemeral: !opts?.permanent,
      };
      const slotIndex = tab.ephemeral
        ? state.tabs.findIndex((candidate) => candidate.kind === "file" && candidate.ephemeral)
        : -1;
      if (slotIndex === -1) {
        state.tabs = [...state.tabs, tab];
      } else {
        const previousId = state.tabs[slotIndex].id;
        state.activationHistory = state.activationHistory.filter((id) => id !== previousId);
        const next = [...state.tabs];
        next.splice(slotIndex, 1, tab);
        state.tabs = next;
      }
      activate(state, tab.id);
    }
    triggerAndPersist();
    request.touchRecentFile({
      directoryId: currentScope.scopeId,
      scopeType: currentScope.scopeType,
      path: filePath,
    }).catch(() => {});
  }

  function promoteTab(id: string): void {
    const state = resolve();
    const tab = state?.tabs.find(
      (candidate): candidate is FilePanelFileTab => candidate.kind === "file" && candidate.id === id,
    );
    if (!tab?.ephemeral) return;
    tab.ephemeral = false;
    triggerAndPersist();
  }

  function openBrowserTab(rawUrl: string, label?: string, id?: string): string {
    const state = resolve();
    if (!state) return "";
    const url = normalizeBrowserUrl(rawUrl);
    const requestedId = id ?? `browser:${crypto.randomUUID()}`;
    const tabId = state.tabs.some((tab) => tab.id === requestedId)
      ? `browser:${crypto.randomUUID()}`
      : requestedId;
    state.pendingClosedIds.delete(tabId);
    state.tabs = [...state.tabs, {
      kind: "browser",
      id: tabId,
      label: label || labelForUrl(url),
      browserUrl: url,
    }];
    activate(state, tabId);
    triggerAndPersist();
    return tabId;
  }

  function closeTab(id: string): void {
    const currentScope = scope();
    const state = resolve();
    if (!state) return;
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const closed = state.tabs[index];
    if (state.hydration !== "loaded") state.pendingClosedIds.add(id);
    if (closed.kind === "file") {
      if (currentScope) {
        closedTabStack.push({
          key: scopeKey(currentScope),
          filePath: closed.filePath,
          cursorLine: closed.cursorLine,
          cursorColumn: closed.cursorColumn,
        });
        if (closedTabStack.length > CLOSED_STACK_MAX) closedTabStack.shift();
      }
      if (dirtyFiles.delete(closed.filePath)) triggerDirty();
    }
    state.tabs = state.tabs.filter((_, tabIndex) => tabIndex !== index);
    state.activationHistory = state.activationHistory.filter((activeTabId) => activeTabId !== id);
    if (state.activeId === id) {
      const liveIds = new Set(state.tabs.map((tab) => tab.id));
      const recentId = [...state.activationHistory].reverse().find((activeTabId) => liveIds.has(activeTabId));
      state.activeId = recentId ?? state.tabs.at(-1)?.id ?? null;
      if (state.hydration !== "loaded") state.pendingActivation = true;
    }
    triggerAndPersist();
  }

  // Reopen the most-recently-closed file tab for the current scope (⌘⇧T).
  function reopenLastClosed(): void {
    const currentScope = scope();
    if (!currentScope) return;
    const key = scopeKey(currentScope);
    for (let index = closedTabStack.length - 1; index >= 0; index--) {
      if (closedTabStack[index].key !== key) continue;
      const [entry] = closedTabStack.splice(index, 1);
      openFile(
        entry.filePath,
        entry.cursorLine ? { line: entry.cursorLine, column: entry.cursorColumn ?? 1 } : undefined,
      );
      return;
    }
  }

  function setScSelection(selection: ScSelection | null): void {
    const state = resolve();
    if (!state) return;
    state.scSelection = selection;
    trigger();
  }

  function setCommitsSelection(selection: CommitsSelection | null): void {
    const state = resolve();
    if (!state) return;
    state.commitsSelection = selection;
    trigger();
  }

  function updateTabViewState(
    id: string,
    view: { scrollTop?: number; cursorLine?: number; cursorColumn?: number },
  ): void {
    const state = resolve();
    const tab = state?.tabs.find(
      (candidate): candidate is FilePanelFileTab => candidate.kind === "file" && candidate.id === id,
    );
    if (!tab) return;
    tab.scrollTop = view.scrollTop;
    tab.cursorLine = view.cursorLine;
    tab.cursorColumn = view.cursorColumn;
    persist();
  }

  function reorderTabs(ids: string[]): void {
    const state = resolve();
    if (!state) return;
    const reordered = reorderById(state.tabs, ids);
    if (!reordered) return;
    state.tabs = reordered;
    triggerAndPersist();
  }

  function focusMostRecentFileOrExplorer(): string | null {
    const state = resolve();
    if (!state) return null;
    const liveById = new Map(state.tabs.map((tab) => [tab.id, tab]));
    for (let index = state.activationHistory.length - 1; index >= 0; index--) {
      const id = state.activationHistory[index];
      const tab = liveById.get(id);
      if (tab?.kind !== "file" && tab?.kind !== "explorer") continue;
      activate(state, id);
      triggerAndPersist();
      return id;
    }
    const fallback = state.tabs.find((tab) => tab.kind === "file" || tab.kind === "explorer");
    if (fallback) {
      activate(state, fallback.id);
      triggerAndPersist();
      return fallback.id;
    }
    return null;
  }

  function setFileDirty(filePath: string, isDirty: boolean): void {
    if (!filePath) return;
    const wasDirty = dirtyFiles.has(filePath);
    if (isDirty) dirtyFiles.add(filePath);
    else dirtyFiles.delete(filePath);
    if (wasDirty !== isDirty) triggerDirty();
    if (isDirty) {
      const tab = resolve()?.tabs.find(
        (candidate): candidate is FilePanelFileTab => candidate.kind === "file" && candidate.filePath === filePath,
      );
      if (tab?.ephemeral) {
        tab.ephemeral = false;
        trigger();
      }
    }
    persist();
  }

  function isFileDirty(filePath: string): boolean {
    dirtyVersion.value;
    return dirtyFiles.has(filePath);
  }

  return {
    tabs,
    scSelection,
    commitsSelection,
    activeId,
    activeTab,
    isMounted,
    setActiveId,
    openTabOfKind,
    openFile,
    openBrowserTab,
    promoteTab,
    closeTab,
    reopenLastClosed,
    setScSelection,
    setCommitsSelection,
    reorderTabs,
    focusMostRecentFileOrExplorer,
    updateTabViewState,
    setFileDirty,
    isFileDirty,
  };
}
