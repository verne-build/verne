import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarState, SidebarTabRow } from "@/types";

const rpc = vi.hoisted(() => ({
  getSidebarTabs: vi.fn<() => Promise<SidebarTabRow[]>>(),
  getSidebarState: vi.fn<() => Promise<SidebarState | null>>(),
  saveSidebarTabs: vi.fn<() => Promise<boolean>>(),
  touchRecentFile: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("./useRpc", () => ({ useRpc: () => ({ request: rpc }) }));

const scope = { path: "/repo", scopeType: "directory" as const, scopeId: "dir-1" };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  rpc.getSidebarTabs.mockResolvedValue([]);
  rpc.getSidebarState.mockResolvedValue(null);
  rpc.saveSidebarTabs.mockResolvedValue(true);
  rpc.touchRecentFile.mockResolvedValue(true);
});

async function loadedState() {
  const persistence = await import("./filePanelPersistence");
  return { persistence, state: await persistence.ensureFilePanelLoaded(scope) };
}

async function loadedTabs() {
  const mod = await import("./useFilePanelTabs");
  await mod.ensureFilePanelLoaded(scope);
  return { mod, panel: mod.useFilePanelTabs(() => scope) };
}

describe("file panel persistence", () => {
  it("seeds and persists History from a legacy rightSidebarView marker", async () => {
    rpc.getSidebarState.mockResolvedValue({
      directoryId: "dir-1",
      activeTabId: "sc",
      listColumnWidth: 250,
      rightSidebarView: "commits",
    });

    const { state } = await loadedState();
    expect(state?.tabs.map((tab) => tab.kind)).toEqual(["commits"]);
    expect(state?.activeId).toBe("__commits__");

    await vi.runAllTimersAsync();
    expect(rpc.saveSidebarTabs).toHaveBeenCalledWith(expect.objectContaining({
      tabs: [expect.objectContaining({ tabType: "commits", position: 0 })],
      filePanelActiveId: "__commits__",
      rightSidebarView: undefined,
    }));
  });

  it("skips unknown persisted tab types without throwing", async () => {
    rpc.getSidebarTabs.mockResolvedValue([
      { directoryId: "dir-1", tabId: "bad", tabType: "future" as never, label: "Bad", position: 0 },
      { directoryId: "dir-1", tabId: "/repo/good.ts", tabType: "file", label: "good.ts", position: 1 },
    ]);

    const { state } = await loadedState();
    expect(state?.tabs.map((tab) => tab.id)).toEqual(["/repo/good.ts"]);
  });

  it("skips historical diff rows without throwing", async () => {
    rpc.getSidebarTabs.mockResolvedValue([
      { directoryId: "dir-1", tabId: "diff:legacy", tabType: "diff" as never, label: "Legacy Diff", position: 0 },
      { directoryId: "dir-1", tabId: "/repo/good.ts", tabType: "file", label: "good.ts", position: 1 },
    ]);

    const { state } = await loadedState();
    expect(state?.tabs.map((tab) => tab.id)).toEqual(["/repo/good.ts"]);
  });

  it.each([
    ["__sc__", "sourceControl", "__sc__"],
    ["__commits__", "commits", "__commits__"],
    ["__notes__", "notes", "__notes__"],
    ["__search__", "search", "__search__"],
  ] as const)("seeds %s from a legacy active marker", async (marker, kind, id) => {
    rpc.getSidebarState.mockResolvedValue({
      directoryId: "dir-1", activeTabId: "ignored", listColumnWidth: 250, filePanelActiveId: marker,
    });

    const { state } = await loadedState();
    expect(state?.tabs).toEqual([expect.objectContaining({ kind, id })]);
    expect(state?.activeId).toBe(id);
    await vi.runAllTimersAsync();
    expect(rpc.saveSidebarTabs).toHaveBeenCalledTimes(1);
  });

  it("prefers filePanelActiveId over a legacy rightSidebarView", async () => {
    rpc.getSidebarState.mockResolvedValue({
      directoryId: "dir-1", activeTabId: "", listColumnWidth: 250,
      filePanelActiveId: "__notes__", rightSidebarView: "commits",
    });

    const { state } = await loadedState();
    expect(state?.tabs.map((tab) => tab.kind)).toEqual(["notes"]);
    expect(state?.activeId).toBe("__notes__");
  });

  it("migrates the explorer marker to a fresh explorer id", async () => {
    rpc.getSidebarState.mockResolvedValue({
      directoryId: "dir-1", activeTabId: "", listColumnWidth: 250, filePanelActiveId: "__explorer__",
    });

    const { state } = await loadedState();
    expect(state?.tabs).toEqual([expect.objectContaining({ kind: "explorer", id: expect.stringMatching(/^explorer:/) })]);
    expect(state?.activeId).toMatch(/^explorer:/);
  });

  it.each([
    ["__newtab__", undefined],
    [undefined, "browser"],
    [undefined, "files"],
  ] as const)("clears an ignored legacy marker without seeding tabs", async (filePanelActiveId, rightSidebarView) => {
    rpc.getSidebarState.mockResolvedValue({
      directoryId: "dir-1", activeTabId: "", listColumnWidth: 250, filePanelActiveId, rightSidebarView,
    });

    const { state } = await loadedState();
    expect(state).toEqual({ tabs: [], activeId: null, needsSave: true });
    await vi.runAllTimersAsync();
    expect(rpc.saveSidebarTabs).toHaveBeenCalledWith(expect.objectContaining({ filePanelActiveId: null, rightSidebarView: undefined }));
  });

  it("retains browser rows without URLs as New Tab", async () => {
    rpc.getSidebarTabs.mockResolvedValue([
      { directoryId: "dir-1", tabId: "browser:1", tabType: "browser", label: "Old", position: 0, browserUrl: null },
    ]);

    const { state } = await loadedState();
    expect(state?.tabs).toEqual([{ kind: "browser", id: "browser:1", label: "New Tab", browserUrl: null }]);
  });

  it("writes a snapshot with canonical rows and nullable browser URLs", async () => {
    const { persistence } = await loadedState();
    persistence.debouncedSave(scope, [
      { kind: "browser", id: "browser:1", label: "New Tab", browserUrl: null },
      { kind: "file", id: "/repo/a.ts", filePath: "/repo/a.ts", label: "a.ts", cursorLine: 3, cursorColumn: 5, scrollTop: 12 },
      { kind: "commits", id: "__commits__" },
    ], "__commits__");
    await vi.runAllTimersAsync();

    expect(rpc.saveSidebarTabs).toHaveBeenCalledWith({
      directoryId: "dir-1", scopeType: "directory",
      tabs: [
        { directoryId: "dir-1", tabId: "browser:1", tabType: "browser", label: "New Tab", position: 0, browserUrl: null },
        { directoryId: "dir-1", tabId: "/repo/a.ts", tabType: "file", label: "a.ts", position: 1, cursorLine: 3, cursorColumn: 5, scrollTop: 12 },
        { directoryId: "dir-1", tabId: "__commits__", tabType: "commits", label: "History", position: 2 },
      ],
      activeTabId: "__commits__", listColumnWidth: 250, rightSidebarView: undefined, filePanelActiveId: "__commits__",
    });
  });

  it("dedupes singleton rows and returns undefined after a scope is loaded", async () => {
    rpc.getSidebarTabs.mockResolvedValue([
      { directoryId: "dir-1", tabId: "one", tabType: "commits", label: "Old", position: 1 },
      { directoryId: "dir-1", tabId: "two", tabType: "commits", label: "Old", position: 0 },
    ]);
    const { persistence, state } = await loadedState();
    expect(state?.tabs).toEqual([{ kind: "commits", id: "__commits__" }]);
    await expect(persistence.ensureFilePanelLoaded(scope)).resolves.toBeUndefined();
    expect(rpc.getSidebarTabs).toHaveBeenCalledTimes(1);
  });

  it("dedupes all hydrated tab ids while preserving the first persisted row", async () => {
    rpc.getSidebarTabs.mockResolvedValue([
      { directoryId: "dir-1", tabId: "/repo/a.ts", tabType: "file", label: "First file", position: 0 },
      { directoryId: "dir-1", tabId: "/repo/a.ts", tabType: "file", label: "Second file", position: 1 },
      { directoryId: "dir-1", tabId: "browser:1", tabType: "browser", label: "First browser", position: 2, browserUrl: "https://first.test" },
      { directoryId: "dir-1", tabId: "browser:1", tabType: "browser", label: "Second browser", position: 3, browserUrl: "https://second.test" },
      { directoryId: "dir-1", tabId: "explorer:1", tabType: "explorer", label: "Files", position: 4 },
      { directoryId: "dir-1", tabId: "explorer:1", tabType: "explorer", label: "Files", position: 5 },
    ]);

    const { state } = await loadedState();
    expect(state?.tabs.map((tab) => tab.id)).toEqual(["/repo/a.ts", "browser:1", "explorer:1"]);
    expect(state?.tabs[0]).toMatchObject({ label: "First file" });
    expect(state?.tabs[1]).toMatchObject({ label: "First browser", browserUrl: "https://first.test" });
  });

  it("ignores an in-flight load completed after its scope is dropped", async () => {
    let resolveRows!: (rows: SidebarTabRow[]) => void;
    rpc.getSidebarTabs.mockImplementationOnce(() => new Promise((resolve) => { resolveRows = resolve; }));
    rpc.getSidebarState.mockResolvedValueOnce({
      directoryId: "dir-1", activeTabId: "", listColumnWidth: 250, rightSidebarView: "commits",
    });
    const persistence = await import("./filePanelPersistence");
    const staleLoad = persistence.ensureFilePanelLoaded(scope);

    persistence.dropFilePanelPersistence(scope.scopeId);
    resolveRows([]);
    await expect(staleLoad).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(rpc.saveSidebarTabs).not.toHaveBeenCalled();

    const freshState = await persistence.ensureFilePanelLoaded(scope);
    expect(freshState).toEqual({ tabs: [], activeId: null, needsSave: false });
    expect(rpc.getSidebarTabs).toHaveBeenCalledTimes(2);
  });

  it("keeps a fresh loaded scope when a dropped load rejects later", async () => {
    let rejectOldLoad!: (error: Error) => void;
    rpc.getSidebarTabs.mockImplementationOnce(() => new Promise((_, reject) => { rejectOldLoad = reject; }));
    const persistence = await import("./filePanelPersistence");
    const oldLoad = persistence.ensureFilePanelLoaded(scope);

    persistence.dropFilePanelPersistence(scope.scopeId);
    await expect(persistence.ensureFilePanelLoaded(scope)).resolves.toEqual({ tabs: [], activeId: null, needsSave: false });

    rejectOldLoad(new Error("offline"));
    await expect(oldLoad).resolves.toBeUndefined();
    await expect(persistence.ensureFilePanelLoaded(scope)).resolves.toBeUndefined();
    expect(rpc.getSidebarTabs).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected load", async () => {
    rpc.getSidebarTabs.mockRejectedValueOnce(new Error("offline"));
    const { persistence, state } = await loadedState();
    expect(state).toBeUndefined();
    await persistence.ensureFilePanelLoaded(scope);
    expect(rpc.getSidebarTabs).toHaveBeenCalledTimes(2);
  });
});

describe("file panel tabs", () => {
  it("opens a singleton once and focuses it on the second request", async () => {
    const { panel } = await loadedTabs();
    const first = panel.openTabOfKind("sourceControl");
    panel.openTabOfKind("notes");
    const second = panel.openTabOfKind("sourceControl");
    expect(second).toBe(first);
    expect(panel.tabs.value.filter((tab) => tab.kind === "sourceControl")).toHaveLength(1);
    expect(panel.activeId.value).toBe("__sc__");
  });

  it("opens a fresh explorer for every request", async () => {
    const { panel } = await loadedTabs();
    const first = panel.openTabOfKind("explorer");
    const second = panel.openTabOfKind("explorer");
    expect(first).not.toBe(second);
    expect(panel.tabs.value.map((tab) => tab.id)).toEqual([first, second]);
  });

  it("opens a blank browser tab labeled New Tab", async () => {
    const { panel } = await loadedTabs();
    const id = panel.openTabOfKind("browser");
    expect(panel.tabs.value).toEqual([
      expect.objectContaining({ kind: "browser", id, label: "New Tab", browserUrl: null }),
    ]);
  });

  it("updates a blank browser in place", async () => {
    const { mod, panel } = await loadedTabs();
    const id = panel.openTabOfKind("browser");
    mod.updateBrowserTab(id, { browserUrl: "https://example.com" });
    expect(panel.tabs.value).toHaveLength(1);
    expect(panel.tabs.value[0]).toMatchObject({ id, browserUrl: "https://example.com" });
  });

  it("opens a file beside its explorer without removing the explorer", async () => {
    const { panel } = await loadedTabs();
    const explorerId = panel.openTabOfKind("explorer");
    panel.openFile("/repo/src/main.ts");
    expect(panel.tabs.value.map((tab) => tab.id)).toEqual([explorerId, "/repo/src/main.ts"]);
  });

  it("closing the last tab leaves the picker state", async () => {
    const { panel } = await loadedTabs();
    const id = panel.openTabOfKind("notes");
    panel.closeTab(id);
    expect(panel.tabs.value).toEqual([]);
    expect(panel.activeId.value).toBeNull();
  });

  it("reorders browser and file tabs in one index space", async () => {
    const { panel } = await loadedTabs();
    panel.openFile("/repo/a.ts", undefined, { permanent: true });
    const browserId = panel.openBrowserTab("https://example.com");
    panel.openFile("/repo/b.ts", undefined, { permanent: true });
    panel.reorderTabs(["/repo/a.ts", "/repo/b.ts", browserId]);
    expect(panel.tabs.value.map((tab) => tab.id)).toEqual(["/repo/a.ts", "/repo/b.ts", browserId]);
  });

  it("focuses the most recently activated file or explorer", async () => {
    const { panel } = await loadedTabs();
    const firstExplorer = panel.openTabOfKind("explorer");
    panel.openFile("/repo/a.ts", undefined, { permanent: true });
    panel.openTabOfKind("explorer");
    panel.setActiveId(firstExplorer);
    panel.openTabOfKind("sourceControl");

    expect(panel.focusMostRecentFileOrExplorer()).toBe(firstExplorer);
    expect(panel.activeId.value).toBe(firstExplorer);
  });

  it("focuses an existing hydrated explorer when activation history has only a static tab", async () => {
    rpc.getSidebarTabs.mockResolvedValue([
      { directoryId: "dir-1", tabId: "__sc__", tabType: "sourceControl", label: "Source Control", position: 0 },
      { directoryId: "dir-1", tabId: "explorer:hydrated", tabType: "explorer", label: "Files", position: 1 },
    ]);
    rpc.getSidebarState.mockResolvedValue({
      directoryId: "dir-1", activeTabId: "", listColumnWidth: 250, filePanelActiveId: "__sc__",
    });
    const { panel } = await loadedTabs();

    expect(panel.focusMostRecentFileOrExplorer()).toBe("explorer:hydrated");
    expect(panel.activeId.value).toBe("explorer:hydrated");
    expect(panel.tabs.value.filter((tab) => tab.kind === "explorer")).toHaveLength(1);
  });

  it("does not reopen a closed file after its scope is dropped", async () => {
    const { mod, panel } = await loadedTabs();
    panel.openFile("/repo/removed.ts", undefined, { permanent: true });
    panel.closeTab("/repo/removed.ts");

    mod.dropFilePanelScope(scope.scopeId);
    await mod.ensureFilePanelLoaded(scope);
    panel.reopenLastClosed();

    expect(panel.tabs.value).toEqual([]);
  });

  it("generates a fresh id when an explicit browser id is already live", async () => {
    const { panel } = await loadedTabs();
    const first = panel.openBrowserTab("https://one.example", undefined, "agent:browser");
    const second = panel.openBrowserTab("https://two.example", undefined, "agent:browser");

    expect(first).toBe("agent:browser");
    expect(second).toMatch(/^browser:/);
    expect(new Set(panel.tabs.value.map((tab) => tab.id))).toEqual(new Set([first, second]));
  });

  it("keeps the existing destination tab when a file path sync collides", async () => {
    const { mod, panel } = await loadedTabs();
    panel.openFile("/repo/old.ts", { line: 3, column: 4 }, { permanent: true });
    const browserId = panel.openBrowserTab("https://example.com");
    panel.openFile("/repo/new.ts", { line: 20, column: 8 }, { permanent: true });
    panel.updateTabViewState("/repo/new.ts", { scrollTop: 99, cursorLine: 21, cursorColumn: 9 });
    panel.setActiveId("/repo/old.ts");
    panel.setFileDirty("/repo/old.ts", true);

    mod.syncFilePanelFilePath("/repo/old.ts", "/repo/new.ts");

    expect(panel.tabs.value.map((tab) => tab.id)).toEqual([browserId, "/repo/new.ts"]);
    expect(panel.tabs.value[1]).toMatchObject({
      filePath: "/repo/new.ts", scrollTop: 99, cursorLine: 21, cursorColumn: 9,
    });
    expect(panel.activeId.value).toBe("/repo/new.ts");
    expect(panel.isFileDirty("/repo/old.ts")).toBe(false);
    expect(panel.isFileDirty("/repo/new.ts")).toBe(true);
  });
});
