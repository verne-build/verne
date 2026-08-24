import type { FilePanelTab, SidebarTabRow } from "@/types";
import {
  COMMITS_TAB_ID, EXPLORER_TAB_ID, NOTES_TAB_ID, SC_TAB_ID, SEARCH_TAB_ID,
} from "@/types";
import { tabTypeEntry } from "@/lib/rightPanelTabTypes";
import { useRpc } from "./useRpc";
import type { FpScope } from "./useFilePanelTabs";

export interface LoadedFilePanelState {
  tabs: FilePanelTab[];
  activeId: string | null;
  needsSave: boolean;
}

const PERSISTED_KINDS = new Set<SidebarTabRow["tabType"]>([
  "file", "browser", "sourceControl", "commits", "search", "notes", "explorer",
]);

const loaded = new Set<string>();
const loading = new Map<string, number>();
const epochs = new Map<string, number>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isPersistedKind(value: string): value is SidebarTabRow["tabType"] {
  return PERSISTED_KINDS.has(value as SidebarTabRow["tabType"]);
}

function scopeKey(scope: FpScope): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

function explorerTab(): Extract<FilePanelTab, { kind: "explorer" }> {
  return { kind: "explorer", id: `explorer:${crypto.randomUUID()}` };
}

function rowToTab(row: SidebarTabRow): FilePanelTab | null {
  if (!isPersistedKind(row.tabType)) return null;
  switch (row.tabType) {
    case "file":
      return {
        kind: "file", id: row.tabId, filePath: row.tabId, label: row.label,
        cursorLine: row.cursorLine, cursorColumn: row.cursorColumn, scrollTop: row.scrollTop,
      };
    case "browser": {
      const browserUrl = row.browserUrl ?? null;
      return { kind: "browser", id: row.tabId, label: browserUrl ? row.label : "New Tab", browserUrl };
    }
    case "sourceControl": return { kind: "sourceControl", id: SC_TAB_ID };
    case "commits": return { kind: "commits", id: COMMITS_TAB_ID };
    case "search": return { kind: "search", id: SEARCH_TAB_ID };
    case "notes": return { kind: "notes", id: NOTES_TAB_ID };
    case "explorer": return row.tabId.startsWith("explorer:") ? { kind: "explorer", id: row.tabId } : explorerTab();
    default: return null;
  }
}

function tabToRow(tab: FilePanelTab, scopeId: string, position: number): SidebarTabRow | null {
  switch (tab.kind) {
    case "file":
      return {
        directoryId: scopeId, tabId: tab.id, tabType: "file", label: tab.label, position,
        cursorLine: tab.cursorLine, cursorColumn: tab.cursorColumn, scrollTop: tab.scrollTop,
      };
    case "browser":
      return {
        directoryId: scopeId, tabId: tab.id, tabType: "browser", label: tab.label, position,
        browserUrl: tab.browserUrl,
      };
    case "sourceControl":
    case "commits":
    case "search":
    case "notes":
    case "explorer":
      return {
        directoryId: scopeId, tabId: tab.id, tabType: tab.kind, label: tabTypeEntry(tab.kind).label, position,
      };
  }
}

function syntheticTab(id: string): FilePanelTab | null {
  switch (id) {
    case SC_TAB_ID: return { kind: "sourceControl", id: SC_TAB_ID };
    case COMMITS_TAB_ID: return { kind: "commits", id: COMMITS_TAB_ID };
    case NOTES_TAB_ID: return { kind: "notes", id: NOTES_TAB_ID };
    case SEARCH_TAB_ID: return { kind: "search", id: SEARCH_TAB_ID };
    case EXPLORER_TAB_ID: return explorerTab();
    default: return null;
  }
}

function legacyViewTab(view: string | undefined): FilePanelTab | null {
  if (view === "sc") return syntheticTab(SC_TAB_ID);
  if (view === "commits") return syntheticTab(COMMITS_TAB_ID);
  return null;
}

function addIfAbsent(tabs: FilePanelTab[], tab: FilePanelTab): void {
  if (!tabs.some((existing) => existing.id === tab.id)) tabs.unshift(tab);
}

export async function ensureFilePanelLoaded(scope: FpScope): Promise<LoadedFilePanelState | undefined> {
  const key = scopeKey(scope);
  if (loaded.has(key) || loading.has(key)) return undefined;
  const epoch = epochs.get(key) ?? 0;
  loading.set(key, epoch);
  try {
    const { request } = useRpc();
    const [rows, sidebarState] = await Promise.all([
      request.getSidebarTabs({ directoryId: scope.scopeId, scopeType: scope.scopeType }),
      request.getSidebarState({ directoryId: scope.scopeId, scopeType: scope.scopeType }),
    ]);
    if ((epochs.get(key) ?? 0) !== epoch) return undefined;
    const seenTabIds = new Set<string>();
    const tabs = [...rows]
      .sort((a, b) => a.position - b.position)
      .flatMap((row) => {
        const tab = rowToTab(row);
        if (!tab || seenTabIds.has(tab.id)) return [];
        seenTabIds.add(tab.id);
        return [tab];
      });

    const persistedActive = sidebarState?.filePanelActiveId;
    const matchingActive = persistedActive && tabs.some((tab) => tab.id === persistedActive) ? persistedActive : null;
    const syntheticActive = !matchingActive && persistedActive ? syntheticTab(persistedActive) : null;
    const viewTab = !matchingActive && !syntheticActive ? legacyViewTab(sidebarState?.rightSidebarView) : null;
    if (syntheticActive) addIfAbsent(tabs, syntheticActive);
    if (viewTab) addIfAbsent(tabs, viewTab);

    const sawLegacyMarker = Boolean(sidebarState?.rightSidebarView)
      || (!matchingActive && persistedActive !== undefined && syntheticActive !== null)
      || persistedActive === "__newtab__";
    const activeId = matchingActive ?? syntheticActive?.id ?? viewTab?.id ?? tabs[0]?.id ?? null;
    const state = { tabs, activeId, needsSave: sawLegacyMarker };
    loaded.add(key);
    return state;
  } catch {
    if ((epochs.get(key) ?? 0) === epoch) loaded.delete(key);
    return undefined;
  } finally {
    if (loading.get(key) === epoch) loading.delete(key);
  }
}

export function debouncedSave(scope: FpScope, tabs: readonly FilePanelTab[], activeId: string | null): void {
  const key = scopeKey(scope);
  const timer = saveTimers.get(key);
  if (timer) clearTimeout(timer);
  const snapshot = tabs.map((tab) => ({ ...tab })) as FilePanelTab[];
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    const rows = snapshot.flatMap((tab, position) => {
      const row = tabToRow(tab, scope.scopeId, position);
      return row ? [row] : [];
    });
    useRpc().request.saveSidebarTabs({
      directoryId: scope.scopeId,
      scopeType: scope.scopeType,
      tabs: rows,
      activeTabId: activeId ?? "",
      listColumnWidth: 250,
      rightSidebarView: undefined,
      filePanelActiveId: activeId,
    }).catch(() => {});
  }, 500));
}

export function dropFilePanelPersistence(scopeId: string): void {
  for (const scopeType of ["directory", "agent_worktree"] as const) {
    const key = `${scopeType}:${scopeId}`;
    const timer = saveTimers.get(key);
    if (timer) clearTimeout(timer);
    saveTimers.delete(key);
    loaded.delete(key);
    loading.delete(key);
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
  }
}
