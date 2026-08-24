import { computed, shallowRef, triggerRef, watch } from "vue";
import type { FilePanelBrowserTab, FilePanelFileTab, FilePanelTab, OpenableTabKind } from "@/types";
import { COMMITS_TAB_ID, NOTES_TAB_ID, SC_TAB_ID, SEARCH_TAB_ID } from "@/types";
import { labelForUrl, normalizeBrowserUrl, sameBrowserUrl } from "@/lib/browserTabs";
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
  pendingMutations: TabMutation[];
  mutationVersion: number;
  retryVersion: number;
}

type BrowserPatch = { label?: string; faviconUrl?: string; browserUrl?: string | null };
type FileViewPatch = { scrollTop?: number; cursorLine?: number; cursorColumn?: number };
type TabMutation =
  | { type: "activate"; id: string }
  | { type: "open-kind"; tab: FilePanelTab; singleton: boolean }
  | { type: "open-file"; filePath: string; position?: { line: number; column: number }; permanent: boolean }
  | { type: "open-browser"; tab: FilePanelBrowserTab }
  | { type: "close"; id: string }
  | { type: "promote"; id: string }
  | { type: "update-browser"; id: string; patch: BrowserPatch }
  | { type: "update-view"; id: string; view: FileViewPatch }
  | { type: "reorder"; ids: string[] }
  | { type: "sync-path"; oldPath: string; newPath: string };

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
    pendingMutations: [],
    mutationVersion: 0,
    retryVersion: 0,
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
  patch: BrowserPatch,
): void {
  for (const [key, state] of dirState.value.entries()) {
    if (!mutate(state, { type: "update-browser", id, patch: { ...patch } })) continue;
    trigger();
    const scope = scopeFromKey(key);
    if (scope) {
      if (state.hydration === "loaded") debouncedSave(scope, state.tabs, state.activeId);
      else {
        state.pendingPersistence = true;
        retryHydrationForMutation(scope, state);
      }
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

function reorderSubset(tabs: FilePanelTab[], ids: readonly string[]): FilePanelTab[] | null {
  const requested = new Set(ids);
  const slots = tabs.flatMap((tab, index) => requested.has(tab.id) ? [index] : []);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = ids.flatMap((id) => {
    const tab = byId.get(id);
    return tab ? [tab] : [];
  });
  if (ordered.length !== slots.length || ordered.length === 0) return null;
  const next = [...tabs];
  slots.forEach((slot, index) => { next[slot] = ordered[index]; });
  return next;
}

function applyMutation(state: DirState, mutation: TabMutation): boolean {
  switch (mutation.type) {
    case "activate":
      if (!state.tabs.some((tab) => tab.id === mutation.id)) return false;
      activate(state, mutation.id);
      return true;
    case "open-kind": {
      const existing = mutation.singleton
        ? state.tabs.find((tab) => tab.id === mutation.tab.id)
        : undefined;
      if (!existing) state.tabs = [...state.tabs, { ...mutation.tab } as FilePanelTab];
      activate(state, existing?.id ?? mutation.tab.id);
      return true;
    }
    case "open-file": {
      const activeExplorerIndex = state.tabs.findIndex(
        (tab) => tab.id === state.activeId && tab.kind === "explorer",
      );
      const existing = state.tabs.find(
        (tab): tab is FilePanelFileTab => tab.kind === "file" && tab.filePath === mutation.filePath,
      );
      if (existing) {
        if (mutation.position) {
          existing.cursorLine = mutation.position.line;
          existing.cursorColumn = mutation.position.column;
          existing.scrollTop = undefined;
          existing.positionVersion = (existing.positionVersion ?? 0) + 1;
        }
        // Hydrated rows are permanent (ephemeral is intentionally not persisted).
        // A preview open must never downgrade an already-permanent row.
        if (mutation.permanent) existing.ephemeral = false;
        if (activeExplorerIndex !== -1) {
          const explorerId = state.tabs[activeExplorerIndex].id;
          state.tabs = state.tabs.filter((_, index) => index !== activeExplorerIndex);
          state.activationHistory = state.activationHistory.filter((id) => id !== explorerId);
        }
        activate(state, existing.id);
        return true;
      }
      const tab: FilePanelFileTab = {
        kind: "file",
        id: mutation.filePath,
        filePath: mutation.filePath,
        label: mutation.filePath.split("/").pop() || mutation.filePath,
        cursorLine: mutation.position?.line,
        cursorColumn: mutation.position?.column,
        ephemeral: !mutation.permanent,
      };
      if (activeExplorerIndex !== -1) {
        const replacedIndices = new Set([activeExplorerIndex]);
        if (tab.ephemeral) {
          const previewIndex = state.tabs.findIndex(
            (candidate) => candidate.kind === "file" && candidate.ephemeral,
          );
          if (previewIndex !== -1) replacedIndices.add(previewIndex);
        }
        const replacedIds = new Set(
          [...replacedIndices].map((index) => state.tabs[index].id),
        );
        const insertIndex = activeExplorerIndex
          - [...replacedIndices].filter((index) => index < activeExplorerIndex).length;
        const next = state.tabs.filter((_, index) => !replacedIndices.has(index));
        next.splice(insertIndex, 0, tab);
        state.tabs = next;
        state.activationHistory = state.activationHistory.filter((id) => !replacedIds.has(id));
        activate(state, tab.id);
        return true;
      }
      const slotIndex = tab.ephemeral
        ? state.tabs.findIndex((candidate) => candidate.kind === "file" && candidate.ephemeral)
        : -1;
      if (slotIndex === -1) state.tabs = [...state.tabs, tab];
      else {
        const previousId = state.tabs[slotIndex].id;
        state.activationHistory = state.activationHistory.filter((id) => id !== previousId);
        const next = [...state.tabs];
        next.splice(slotIndex, 1, tab);
        state.tabs = next;
      }
      activate(state, tab.id);
      return true;
    }
    case "open-browser": {
      const existing = state.tabs.find((tab) => tab.id === mutation.tab.id);
      if (existing) {
        if (existing.kind !== "browser") return false;
        existing.label = mutation.tab.label;
        existing.browserUrl = mutation.tab.browserUrl;
        activate(state, existing.id);
        return true;
      }
      state.tabs = [...state.tabs, { ...mutation.tab }];
      activate(state, mutation.tab.id);
      return true;
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === mutation.id);
      if (index === -1) return false;
      state.tabs = state.tabs.filter((_, tabIndex) => tabIndex !== index);
      state.activationHistory = state.activationHistory.filter((id) => id !== mutation.id);
      if (state.activeId === mutation.id) {
        const liveIds = new Set(state.tabs.map((tab) => tab.id));
        const recentId = [...state.activationHistory].reverse().find((id) => liveIds.has(id));
        state.activeId = recentId ?? state.tabs.at(-1)?.id ?? null;
        recordActivation(state, state.activeId);
      }
      return true;
    }
    case "promote": {
      const tab = state.tabs.find(
        (candidate): candidate is FilePanelFileTab => candidate.kind === "file" && candidate.id === mutation.id,
      );
      if (!tab?.ephemeral) return false;
      tab.ephemeral = false;
      return true;
    }
    case "update-browser": {
      const tab = state.tabs.find(
        (candidate): candidate is FilePanelBrowserTab => candidate.kind === "browser" && candidate.id === mutation.id,
      );
      if (!tab) return false;
      if (mutation.patch.label !== undefined) tab.label = mutation.patch.label;
      if (mutation.patch.faviconUrl !== undefined) tab.faviconUrl = mutation.patch.faviconUrl;
      if (mutation.patch.browserUrl !== undefined) tab.browserUrl = mutation.patch.browserUrl;
      return true;
    }
    case "update-view": {
      const tab = state.tabs.find(
        (candidate): candidate is FilePanelFileTab => candidate.kind === "file" && candidate.id === mutation.id,
      );
      if (!tab) return false;
      tab.scrollTop = mutation.view.scrollTop;
      tab.cursorLine = mutation.view.cursorLine;
      tab.cursorColumn = mutation.view.cursorColumn;
      return true;
    }
    case "reorder": {
      const reordered = reorderSubset(state.tabs, mutation.ids);
      if (!reordered) return false;
      state.tabs = reordered;
      return true;
    }
    case "sync-path": {
      const index = state.tabs.findIndex(
        (tab) => tab.kind === "file" && tab.filePath === mutation.oldPath,
      );
      if (index === -1) return false;
      const destinationIndex = state.tabs.findIndex(
        (tab, tabIndex) => tabIndex !== index && tab.kind === "file" && tab.filePath === mutation.newPath,
      );
      if (destinationIndex === -1) {
        const newLabel = mutation.newPath.split("/").pop() || mutation.newPath;
        state.tabs = state.tabs.map((tab, tabIndex) =>
          tabIndex === index && tab.kind === "file"
            ? { ...tab, id: mutation.newPath, filePath: mutation.newPath, label: newLabel }
            : tab,
        );
      } else state.tabs = state.tabs.filter((_, tabIndex) => tabIndex !== index);
      if (state.activeId === mutation.oldPath) state.activeId = mutation.newPath;
      const remappedHistory = state.activationHistory.map(
        (id) => id === mutation.oldPath ? mutation.newPath : id,
      );
      state.activationHistory = remappedHistory.filter(
        (id, historyIndex) => remappedHistory.lastIndexOf(id) === historyIndex,
      );
      return true;
    }
  }
}

function mutate(state: DirState, mutation: TabMutation): boolean {
  const changed = applyMutation(state, mutation);
  if (changed && state.hydration !== "loaded") {
    state.pendingMutations.push(mutation);
    state.mutationVersion++;
  }
  return changed;
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
      retryHydrationForMutation(scope, state);
      return;
    }

    const pendingMutations = [...state.pendingMutations];
    const needsSave = state.pendingPersistence || pendingMutations.length > 0 || loaded.needsSave;
    state.tabs = loaded.tabs;
    state.activeId = loaded.activeId;
    state.activationHistory = loaded.activeId ? [loaded.activeId] : [];
    for (const mutation of pendingMutations) applyMutation(state, mutation);
    state.hydration = "loaded";
    state.hydrationPromise = null;
    state.pendingPersistence = false;
    state.pendingMutations = [];
    state.retryVersion = state.mutationVersion;
    trigger();
    if (needsSave) debouncedSave(scope, state.tabs, state.activeId);
  })();
  state.hydrationPromise = hydration;
  return hydration;
}

function retryHydrationForMutation(scope: FpScope, state: DirState): void {
  if (
    state.hydration !== "idle"
    || !state.pendingPersistence
    || state.retryVersion >= state.mutationVersion
  ) return;
  state.retryVersion = state.mutationVersion;
  queueMicrotask(() => {
    if (dirState.value.get(scopeKey(scope)) !== state || state.hydration !== "idle") return;
    void ensureFilePanelLoaded(scope);
  });
}

export interface ScopedBrowserOpenResult {
  tabId: string;
  reused: boolean;
  created: boolean;
}

export async function openBrowserTabForScope(
  scope: FpScope,
  rawUrl: string,
  options: { newTabId: string; allowReuse: boolean },
): Promise<ScopedBrowserOpenResult> {
  await ensureFilePanelLoaded(scope);
  const state = getOrCreate(scopeKey(scope));
  if (state.hydration !== "loaded") throw new Error(`browser tab scope ${scope.scopeId} failed to load`);
  const url = normalizeBrowserUrl(rawUrl);
  const candidate = state.tabs.find((tab) => tab.id === options.newTabId);
  if (candidate) {
    if (candidate.kind !== "browser") {
      throw new Error(`browser tab id ${options.newTabId} is already in use`);
    }
    mutate(state, { type: "activate", id: candidate.id });
    trigger();
    debouncedSave(scope, state.tabs, state.activeId);
    return { tabId: candidate.id, reused: false, created: true };
  }
  if (options.allowReuse) {
    const existing = state.tabs.find(
      (tab): tab is FilePanelBrowserTab =>
        tab.kind === "browser" && Boolean(tab.browserUrl) && sameBrowserUrl(tab.browserUrl!, url),
    );
    if (existing) {
      mutate(state, { type: "activate", id: existing.id });
      trigger();
      debouncedSave(scope, state.tabs, state.activeId);
      return { tabId: existing.id, reused: true, created: false };
    }
  }
  mutate(state, {
    type: "open-browser",
    tab: {
      kind: "browser",
      id: options.newTabId,
      label: labelForUrl(url),
      browserUrl: url,
    },
  });
  trigger();
  debouncedSave(scope, state.tabs, state.activeId);
  return { tabId: options.newTabId, reused: false, created: true };
}

export async function rollbackBrowserTabForScope(
  scope: FpScope,
  newTabId: string,
  _rawUrl: string,
): Promise<boolean> {
  await ensureFilePanelLoaded(scope);
  const state = getOrCreate(scopeKey(scope));
  if (state.hydration !== "loaded") return false;
  const tab = state.tabs.find(
    (candidate): candidate is FilePanelBrowserTab => candidate.kind === "browser" && candidate.id === newTabId,
  );
  if (!tab) return false;
  if (!mutate(state, { type: "close", id: newTabId })) return false;
  trigger();
  debouncedSave(scope, state.tabs, state.activeId);
  return true;
}

export function syncFilePanelFilePath(oldPath: string, newPath: string): void {
  for (const [key, state] of dirState.value.entries()) {
    if (!mutate(state, { type: "sync-path", oldPath, newPath })) continue;
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
        state.pendingPersistence = true;
        retryHydrationForMutation(scope, state);
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
      retryHydrationForMutation(currentScope, state);
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
    if (!state || !mutate(state, { type: "activate", id })) return;
    triggerAndPersist();
  }

  function openTabOfKind(kind: OpenableTabKind): string {
    const state = resolve();
    if (!state) return "";
    const singletonId = kind in SINGLETON_IDS
      ? SINGLETON_IDS[kind as keyof typeof SINGLETON_IDS]
      : null;
    const id = singletonId ?? `${kind}:${crypto.randomUUID()}`;
    mutate(state, {
      type: "open-kind",
      tab: makeTabOfKind(kind, id),
      singleton: singletonId !== null,
    });
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
    mutate(state, {
      type: "open-file",
      filePath,
      position: position ? { ...position } : undefined,
      permanent: Boolean(opts?.permanent),
    });
    triggerAndPersist();
    request.touchRecentFile({
      directoryId: currentScope.scopeId,
      scopeType: currentScope.scopeType,
      path: filePath,
    }).catch(() => {});
  }

  function promoteTab(id: string): void {
    const state = resolve();
    if (!state || !mutate(state, { type: "promote", id })) return;
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
    mutate(state, {
      type: "open-browser",
      tab: { kind: "browser", id: tabId, label: label || labelForUrl(url), browserUrl: url },
    });
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
    mutate(state, { type: "close", id });
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
    if (!state || !mutate(state, { type: "update-view", id, view: { ...view } })) return;
    persist();
  }

  function reorderTabs(ids: string[]): void {
    const state = resolve();
    if (!state) return;
    const reordered = reorderById(state.tabs, ids);
    if (!reordered) return;
    mutate(state, { type: "reorder", ids: [...ids] });
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
      mutate(state, { type: "activate", id });
      triggerAndPersist();
      return id;
    }
    const fallback = state.tabs.find((tab) => tab.kind === "file" || tab.kind === "explorer");
    if (fallback) {
      mutate(state, { type: "activate", id: fallback.id });
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
      const state = resolve();
      if (state && mutate(state, { type: "promote", id: filePath })) trigger();
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
