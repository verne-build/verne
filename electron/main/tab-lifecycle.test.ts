import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createTabLifecycleHandlers } from "./tab-lifecycle";
import type { Tab, TabGroup, WorkingDirectory } from "../../src/types/shared";

function fakeWindow() {
  const send = vi.fn();
  return {
    win: { webContents: { send } } as unknown as BrowserWindow,
    send,
  };
}

function setup() {
  const tabs: Tab[] = [];
  const groups: TabGroup[] = [];
  const dirs = new Map<string, WorkingDirectory>([
    ["dir-1", {
      id: "dir-1",
      path: "/repo",
      name: "repo",
      repoRoot: "/repo",
      createdAt: 1,
      sortOrder: 0,
    }],
  ]);
  const db = {};
  const deps = {
    getDb: vi.fn(() => db as any),
    getDirectory: vi.fn((_db: unknown, id: string) => dirs.get(id)),
    resolveWorkspaceRoot: vi.fn(() => "/repo"),
    getTabs: vi.fn((_db: unknown, directoryId?: string | null) =>
      directoryId ? tabs.filter((t) => t.directoryId === directoryId) : tabs,
    ),
    getTab: vi.fn((_db: unknown, id: string) => tabs.find((t) => t.id === id)),
    insertTab: vi.fn((_db: unknown, tab: Tab) => { tabs.push(tab); }),
    deleteTab: vi.fn((_db: unknown, id: string) => {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx !== -1) tabs.splice(idx, 1);
    }),
    renameTab: vi.fn((_db: unknown, id: string, label: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) {
        tab.label = label;
        tab.userRenamed = true;
      }
    }),
    reorderTabs: vi.fn(),
    tabDisplayLabels: vi.fn((_db: unknown, tabId: string) => ({
      directoryName: "repo",
      tabLabel: tabs.find((t) => t.id === tabId)?.label,
    })),
    createGroup: vi.fn((_db: unknown, directoryId: string, layout: string, activePaneId?: string) => {
      const group: TabGroup = {
        id: "group-1",
        directoryId,
        sortOrder: groups.length,
        activePaneId,
        layout,
        createdAt: 123,
      };
      groups.push(group);
      return group;
    }),
    deleteGroup: vi.fn((_db: unknown, id: string) => {
      const idx = groups.findIndex((g) => g.id === id);
      if (idx !== -1) groups.splice(idx, 1);
    }),
    forgetNotificationTab: vi.fn(),
    randomId: vi.fn(() => "tab-1"),
    now: vi.fn(() => 123),
  };
  const daemon = { request: vi.fn(async () => "session-1") };
  const sidecar = { request: vi.fn(async () => true) };
  const handlers = createTabLifecycleHandlers(daemon as any, sidecar as any, deps as any);
  return { tabs, groups, deps, daemon, sidecar, handlers };
}

describe("tab lifecycle handlers", () => {
  it("creates a tab, spawns its PTY, and emits after spawn succeeds", async () => {
    const { tabs, groups, daemon, handlers } = setup();
    const { win, send } = fakeWindow();

    const { tab, group } = await handlers.tabsCreate({ opts: { directoryId: "dir-1" } }, win) as {
      tab: Tab;
      group: TabGroup;
    };

    expect(tab).toMatchObject({
      id: "tab-1",
      directoryId: "dir-1",
      label: "1",
      cwd: "/repo",
      createdAt: 123,
      userRenamed: false,
    });
    expect(tabs).toHaveLength(1);
    expect(group).toMatchObject({
      id: "group-1",
      directoryId: "dir-1",
      activePaneId: "tab-1",
      layout: JSON.stringify({ pane: "tab-1" }),
    });
    expect(groups).toEqual([group]);
    expect(daemon.request).toHaveBeenCalledWith("tab_spawn", {
      plan: {
        tabId: "tab-1",
        cwd: "/repo",
        env: { VERNE_WORKSPACE_DIR: "/repo" },
        agentSessionId: undefined,
        directoryName: "repo",
        tabLabel: "1",
      },
    });
    expect(send).toHaveBeenCalledWith("daemon-event", "tab-added", { tab });
  });

  it("rolls back the tab row and emits nothing when PTY spawn fails", async () => {
    const { tabs, groups, deps, daemon, handlers } = setup();
    daemon.request.mockRejectedValueOnce(new Error("spawn failed"));
    const { win, send } = fakeWindow();

    await expect(handlers.tabsCreate({ opts: { directoryId: "dir-1" } }, win))
      .rejects.toThrow("spawn failed");

    expect(tabs).toHaveLength(0);
    expect(groups).toHaveLength(0);
    expect(deps.insertTab).toHaveBeenCalledOnce();
    expect(deps.deleteGroup).toHaveBeenCalledWith(expect.anything(), "group-1");
    expect(deps.deleteTab).toHaveBeenCalledWith(expect.anything(), "tab-1");
    expect(send).not.toHaveBeenCalled();
  });

  it("can create a tab row without a new pane group for split-pane migration", async () => {
    const { tabs, groups, handlers } = setup();

    const result = await handlers.tabsCreate({
      opts: { directoryId: "dir-1", createGroup: false },
    }, fakeWindow().win) as { tab: Tab; group?: TabGroup };

    expect(result.tab.id).toBe("tab-1");
    expect(result.group).toBeUndefined();
    expect(tabs).toHaveLength(1);
    expect(groups).toHaveLength(0);
  });

  it("closes a tab with best-effort daemon and sidecar cleanup", async () => {
    const { tabs, deps, daemon, sidecar, handlers } = setup();
    tabs.push({
      id: "tab-1",
      directoryId: "dir-1",
      label: "1",
      cwd: "/repo",
      sortOrder: 0,
      createdAt: 123,
      userRenamed: false,
    });
    daemon.request.mockRejectedValueOnce(new Error("already gone"));
    const { win, send } = fakeWindow();

    await expect(handlers.tabsClose({ id: "tab-1" }, win)).resolves.toBe(true);

    expect(tabs).toHaveLength(0);
    expect(daemon.request).toHaveBeenCalledWith("tab_kill", { tabId: "tab-1" });
    expect(sidecar.request).toHaveBeenCalledWith("agent_shadow_cleanup", { tabId: "tab-1" });
    expect(deps.forgetNotificationTab).toHaveBeenCalledWith("tab-1");
    expect(send).toHaveBeenCalledWith("daemon-event", "tab-deleted", { id: "tab-1" });
  });

  it("ensures an existing tab session by spawning from the persisted row", async () => {
    const { tabs, daemon, handlers } = setup();
    tabs.push({
      id: "tab-1",
      directoryId: "dir-1",
      label: "Shell",
      cwd: "/repo/sub",
      sortOrder: 0,
      createdAt: 123,
      userRenamed: false,
    });

    await expect(handlers.tabsSessionId({ id: "tab-1" }, fakeWindow().win)).resolves.toBe("session-1");

    expect(daemon.request).toHaveBeenCalledWith("tab_spawn", {
      plan: {
        tabId: "tab-1",
        cwd: "/repo/sub",
        env: { VERNE_WORKSPACE_DIR: "/repo" },
        agentSessionId: undefined,
        directoryName: "repo",
        tabLabel: "Shell",
      },
    });
  });

  it("does not mutate persisted tabs when session ensure spawn fails", async () => {
    const { tabs, deps, daemon, handlers } = setup();
    const persisted: Tab = {
      id: "tab-1",
      directoryId: "dir-1",
      label: "Shell",
      cwd: "/repo/sub",
      sortOrder: 0,
      createdAt: 123,
      userRenamed: false,
    };
    tabs.push(persisted);
    daemon.request.mockRejectedValueOnce(new Error("spawn failed"));

    await expect(handlers.tabsSessionId({ id: "tab-1" }, fakeWindow().win))
      .rejects.toThrow("spawn failed");

    expect(tabs).toEqual([persisted]);
    expect(deps.insertTab).not.toHaveBeenCalled();
    expect(deps.deleteTab).not.toHaveBeenCalled();
  });
});
