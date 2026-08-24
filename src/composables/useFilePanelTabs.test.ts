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

  it("retries a rejected load", async () => {
    rpc.getSidebarTabs.mockRejectedValueOnce(new Error("offline"));
    const { persistence, state } = await loadedState();
    expect(state).toBeUndefined();
    await persistence.ensureFilePanelLoaded(scope);
    expect(rpc.getSidebarTabs).toHaveBeenCalledTimes(2);
  });
});
