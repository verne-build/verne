// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Tab, TabUpdatedEvent } from "@/types";

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

vi.mock("@/composables/useLanguageClient", () => ({ stopClient: vi.fn() }));
vi.mock("vue-sonner", () => ({ toast: vi.fn() }));

const appState = new Map<string, string>();
let tabsListResult: Tab[] = [];
let liveTabIds: string[] = [];

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      getAppState: vi.fn(async (p: { key: string }) => appState.get(p.key) ?? null),
      setAppState: vi.fn(async (p: { key: string; value: string | null }) => {
        if (p.value === null) appState.delete(p.key);
        else appState.set(p.key, p.value);
        return true;
      }),
      groupsList: vi.fn(async () => []),
      tabsList: vi.fn(async () => tabsListResult),
      getAgentStates: vi.fn(async () => []),
      listLiveTabIds: vi.fn(async () => liveTabIds),
      tabsReorder: vi.fn(async () => true),
      setActiveDirectory: vi.fn(async () => true),
      prewarmFileIndex: vi.fn(async () => true),
    },
  }),
}));

import { useWorkspaceStore } from "./workspace";

const dir = (id: string) => ({ id, path: `/${id}`, name: id, createdAt: 0, sortOrder: 0 });

function mkTab(over: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    directoryId: "dir-1",
    label: "1",
    cwd: "/dir-1",
    sortOrder: 0,
    createdAt: 0,
    userRenamed: false,
    ...over,
  };
}

const upd = (over: Partial<TabUpdatedEvent> = {}): TabUpdatedEvent =>
  ({ tabId: "t1", agentState: "working", ...over }) as TabUpdatedEvent;

describe("latched identity in the renderer", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    appState.clear();
    tabsListResult = [];
    liveTabIds = [];
  });

  // Finding 1: main stamps the latched identity on tab-updated; the stored row
  // must be patched or Resume stays hidden until the next app relaunch.
  it("applyTabUpdate patches the stored row with resumeAvailable", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    tabsListResult = [mkTab()];
    await store.loadTabsForDirectory("dir-1");
    expect(store.terminalTabsByDirectory["dir-1"][0].resumeAvailable).toBeUndefined();

    store.applyTabUpdate(
      upd({
        revision: 1,
        agentType: "claude",
        lastAgentType: "claude",
        lastAgentSessionId: "sid-1",
        resumeAvailable: true,
      }),
    );

    const row = store.terminalTabsByDirectory["dir-1"][0];
    expect(row.resumeAvailable).toBe(true);
    expect(row.lastAgentSessionId).toBe("sid-1");
    expect(row.lastAgentType).toBe("claude");
  });

  it("applyTabUpdate does not swap the row when the identity is unchanged", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    tabsListResult = [mkTab()];
    await store.loadTabsForDirectory("dir-1");

    const identity = { lastAgentType: "claude", lastAgentSessionId: "sid-1", resumeAvailable: true };
    store.applyTabUpdate(upd({ revision: 1, agentType: "claude", ...identity }));
    const patched = store.terminalTabsByDirectory["dir-1"][0];
    store.applyTabUpdate(upd({ revision: 2, agentType: "claude", agentState: "idle", ...identity }));
    expect(store.terminalTabsByDirectory["dir-1"][0]).toBe(patched);
  });

  // Finding 6: lastAgentType is latched now, so seeding on it made exited
  // sessions show a live Idle dot.
  it("hydration seeds runtime only for tabs with a live state", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    tabsListResult = [
      mkTab({ id: "exited", lastAgentType: "claude", lastAgentSessionId: "sid" }),
      mkTab({ id: "live", lastAgentType: "claude", lastAgentState: "working" }),
    ];
    await store.loadTabsForDirectory("dir-1");
    expect(store.tabRuntime.get("exited")).toBeUndefined();
    expect(store.tabRuntime.get("live")?.agentState).toBe("working");
  });

  // Finding 7: agentsList used to key on the (latched) type alone.
  it("agentsList excludes sessions with a remembered type but no live state", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    tabsListResult = [
      mkTab({ id: "exited", lastAgentType: "claude" }),
      mkTab({ id: "live", lastAgentType: "claude", lastAgentState: "working" }),
    ];
    await store.loadTabsForDirectory("dir-1");
    expect(store.agentsList("all").map((a) => a.tab.id)).toEqual(["live"]);
  });
});
