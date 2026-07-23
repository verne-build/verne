// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/platform", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(() => Promise.resolve(() => {})),
  ask: vi.fn(),
  convertFileSrc: vi.fn(),
  filePathForFile: vi.fn(),
  openExternal: vi.fn(),
  showSaveDialog: vi.fn(),
  openInIde: vi.fn(),
  getInstalledIdes: vi.fn(),
  startDragging: vi.fn(),
}));

vi.mock("@/composables/useLanguageClient", () => ({
  stopClient: vi.fn(),
}));

const toastMock = vi.fn();
vi.mock("vue-sonner", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

const setAppStateCalls: Array<{ key: string; value: string | null }> = [];
const tabMoveToDirectoryCalls: Array<{ id: string; directoryId: string }> = [];
const appState = new Map<string, string>();
const tabsListByDir: Record<string, unknown[]> = {};

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      getAppState: vi.fn(async (p: { key: string }) => appState.get(p.key) ?? null),
      setAppState: vi.fn(async (p: { key: string; value: string | null }) => {
        setAppStateCalls.push(p);
        if (p.value === null) appState.delete(p.key);
        else appState.set(p.key, p.value);
        return true;
      }),
      groupsList: vi.fn(async () => []),
      tabsList: vi.fn(async (p: { directoryId?: string }) =>
        p.directoryId ? tabsListByDir[p.directoryId] ?? [] : Object.values(tabsListByDir).flat(),
      ),
      getAgentStates: vi.fn(async () => []),
      tabsCreate: vi.fn(async (opts: { directoryId: string; label?: string; cwd?: string }) => ({
        id: `tab-${Math.random().toString(36).slice(2)}`,
        directoryId: opts.directoryId,
        label: opts.label ?? "shell",
        cwd: opts.cwd ?? null,
      })),
      tabsReorder: vi.fn(async () => true),
      listLiveTabIds: vi.fn(async () => []),
      setActiveDirectory: vi.fn(async () => true),
      prewarmFileIndex: vi.fn(async () => true),
      tabMoveToDirectory: vi.fn(async (p: { id: string; directoryId: string }) => {
        tabMoveToDirectoryCalls.push(p);
        return true;
      }),
    },
  }),
}));

import { useWorkspaceStore } from "./workspace";

const dir = (id: string) => ({ id, path: `/${id}`, name: id, createdAt: 0, sortOrder: 0 });

describe("applyScopeChange", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabMoveToDirectoryCalls.length = 0;
    appState.clear();
    toastMock.mockClear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
  });

  it("echo no-op: tab already in destination bucket, no toast, no writes", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    setAppStateCalls.length = 0;

    store.applyScopeChange({
      tabId: tab.id,
      fromDirectoryId: "dir-1",
      toDirectoryId: "dir-1",
      cwd: "/dir-1",
    });

    expect(toastMock).not.toHaveBeenCalled();
    expect(setAppStateCalls).toEqual([]);
  });

  it("neither-bucket no-op: tab absent from both buckets, no toast, no writes", async () => {
    const store = useWorkspaceStore();
    await store.newSession("dir-1");
    setAppStateCalls.length = 0;

    store.applyScopeChange({
      tabId: "ghost-tab",
      fromDirectoryId: "dir-1",
      toDirectoryId: "dir-2",
      cwd: "/dir-2",
    });

    expect(toastMock).not.toHaveBeenCalled();
    expect(setAppStateCalls).toEqual([]);
  });

  it("bucket move + source solo collapse deletes the source arrangement key", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    setAppStateCalls.length = 0;

    store.applyScopeChange({
      tabId: tab.id,
      fromDirectoryId: "dir-1",
      toDirectoryId: "dir-2",
      cwd: "/dir-2",
    });

    expect(store.terminalTabsByDirectory["dir-1"]?.some((t) => t.id === tab.id)).toBe(false);
    expect(store.terminalTabsByDirectory["dir-2"]?.some((t) => t.id === tab.id)).toBe(true);
    expect(store.arrangementByScope["dir-1"]).toBeUndefined();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("focus falls through to the surviving pane in a split", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    await store.splitSessionWithNew(tab1.id, "h");
    const arr = store.arrangementByScope["dir-1"];
    const tab2Id = arr.layout.children.find((c: { pane: string }) => c.pane !== tab1.id).pane;
    store.focusSession(tab2Id);
    setAppStateCalls.length = 0;

    store.applyScopeChange({
      tabId: tab2Id,
      fromDirectoryId: "dir-1",
      toDirectoryId: "dir-2",
      cwd: "/dir-2",
    });

    const lastFocusWrite = setAppStateCalls.filter((c) => c.key === "focused_by_scope").at(-1);
    expect(JSON.parse(lastFocusWrite!.value!)["dir-1"]).toBe(tab1.id);
  });

  it("selected-session-follow: right panel swaps scopes to follow the moved session", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    store.selectDirectory(dir("dir-1"));
    store.directories.push(dir("dir-2"));
    store.focusSession(tab1.id);

    store.applyScopeChange({
      tabId: tab1.id,
      fromDirectoryId: "dir-1",
      toDirectoryId: "dir-2",
      cwd: "/dir-2",
    });

    expect(store.selectedDirectoryId).toBe("dir-2");
    expect(store.focusedSessionId).toBe(tab1.id);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("stale focus cleanup: moving the sole focused session out clears focusedByScope/activeTabIdByDirectory for the source", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    // Not the selected scope, so the follow-swap path doesn't fire — isolates
    // the stale-focus-cleanup behavior on its own.
    store.selectDirectory(dir("other"));

    store.applyScopeChange({
      tabId: tab1.id,
      fromDirectoryId: "dir-1",
      toDirectoryId: "dir-2",
      cwd: "/dir-2",
    });

    const lastFocusWrite = setAppStateCalls.filter((c) => c.key === "focused_by_scope").at(-1);
    expect(lastFocusWrite).toBeTruthy();
    expect(JSON.parse(lastFocusWrite!.value!)["dir-1"]).toBeUndefined();
  });
});
