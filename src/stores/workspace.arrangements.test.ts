// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { watch } from "vue";

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

let nextId = 0;
function freshId(prefix: string) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

const setAppStateCalls: Array<{ key: string; value: string | null }> = [];
const tabsClosedIds: string[] = [];
const tabsSessionIdCalls: string[] = [];
const tabsArchiveCalls: string[] = [];
let tabsArchiveNext: unknown = null;
function setTabsArchiveResult(tab: unknown) {
  tabsArchiveNext = tab;
}
const tabsUnarchiveCalls: Array<{ id: string; resume: boolean }> = [];
let tabsUnarchiveNext: unknown = null;
function setTabsUnarchiveResult(tab: unknown) {
  tabsUnarchiveNext = tab;
}
const tabsCreateCalls: Array<{
  directoryId: string;
  label?: string;
  cwd?: string;
  agentLaunch?: {
    agentType: string;
    modelId: string | null;
    effort: string | null;
    fast: boolean | null;
  };
}> = [];
const rpc = vi.hoisted(() => ({
  gitCheckoutBranch: vi.fn(),
  worktreeCreate: vi.fn(async () => ({
    id: "wt-new",
    path: "/wt-new",
    name: "wt-new",
    createdAt: 0,
    sortOrder: 1,
    parentDirectoryId: "dir-1",
  })),
  worktreeRemove: vi.fn(async () => true),
  tabsCreate: vi.fn(),
}));
const filePanel = vi.hoisted(() => ({
  dropFilePanelScope: vi.fn(),
}));
const {
  getLiveTabIds,
  setLiveTabIds,
  setLiveTabIdsDeferred,
  resolveLiveTabIdsDeferred,
  queueLiveTabIdsDeferred,
  getTabsListDeferred,
  queueTabsListDeferred,
  getTabsCreateDeferred,
  queueTabsCreateDeferred,
  appState,
  setFailArrangementGets,
  takeArrangementGetFailure,
  tabsListByDir,
  tabsListCalls,
  agentStates,
  getDirectoriesResult,
  setDirectoriesResult,
} = vi.hoisted(() => {
  let liveTabIds: string[] = [];
  let deferred: { promise: Promise<string[]>; resolve: (ids: string[]) => void } | null = null;
  const queue: Array<{ promise: Promise<string[]>; resolve: (ids: string[]) => void }> = [];
  const tabsCreateQueue: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const tabsListQueue: Array<{
    promise: Promise<unknown[]>;
    resolve: (tabs: unknown[]) => void;
    reject: (error: unknown) => void;
  }> = [];
  function makeDeferred() {
    let resolve!: (ids: string[]) => void;
    const promise = new Promise<string[]>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  function makeVoidDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  // Mutable app_state + tabs_list fixtures + injectable arrangement-get failures.
  const appState = new Map<string, string>();
  const tabsListByDir: Record<string, unknown[]> = {};
  const tabsListCalls: Array<string | undefined> = [];
  const agentStates: unknown[] = [];
  let directoriesResult: unknown[] = [];
  let failArrangementGets = 0;
  return {
    appState,
    tabsListByDir,
    tabsListCalls,
    agentStates,
    setDirectoriesResult: (directories: unknown[]) => {
      directoriesResult = directories;
    },
    getDirectoriesResult: () => directoriesResult,
    setFailArrangementGets: (n: number) => {
      failArrangementGets = n;
    },
    takeArrangementGetFailure: () => {
      if (failArrangementGets <= 0) return false;
      failArrangementGets -= 1;
      return true;
    },
    getLiveTabIds: () => {
      if (queue.length > 0) return queue.shift()!.promise;
      return deferred?.promise ?? liveTabIds;
    },
    setLiveTabIds: (ids: string[]) => {
      liveTabIds = ids;
    },
    setLiveTabIdsDeferred: () => {
      deferred = makeDeferred();
    },
    resolveLiveTabIdsDeferred: (ids: string[]) => {
      deferred?.resolve(ids);
      deferred = null;
    },
    // Queue N deferred promises consumed in call order by successive
    // listLiveTabIds invocations (for testing concurrent hydrates).
    queueLiveTabIdsDeferred: () => {
      const d = makeDeferred();
      queue.push(d);
      return d;
    },
    getTabsListDeferred: () => tabsListQueue.shift() ?? null,
    queueTabsListDeferred: () => {
      let resolve!: (tabs: unknown[]) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<unknown[]>((r, j) => {
        resolve = r;
        reject = j;
      });
      const d = { promise, resolve, reject };
      tabsListQueue.push(d);
      return d;
    },
    // Consumed in tabsCreate call order; letting the test resolve them out
    // of order simulates concurrent tabsCreate RPCs completing out of order.
    getTabsCreateDeferred: () => tabsCreateQueue.shift() ?? null,
    queueTabsCreateDeferred: () => {
      const d = makeVoidDeferred();
      tabsCreateQueue.push(d);
      return d;
    },
  };
});

const defaultTabsCreate = async (opts: {
  directoryId: string;
  label?: string;
  cwd?: string;
  agentLaunch?: {
    agentType: string;
    modelId: string | null;
    effort: string | null;
    fast: boolean | null;
  };
}) => {
  tabsCreateCalls.push({ ...opts });
  const deferred = getTabsCreateDeferred();
  if (deferred) await deferred.promise;
  return {
    id: freshId("tab"),
    directoryId: opts.directoryId,
    label: opts.label ?? "shell",
    cwd: opts.cwd ?? null,
  };
};

rpc.tabsCreate.mockImplementation(defaultTabsCreate);

vi.mock("@/composables/useLanguageClient", () => ({
  stopClient: vi.fn(),
}));

vi.mock("@/composables/useFilePanelTabs", () => ({
  dropFilePanelScope: filePanel.dropFilePanelScope,
}));

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      getAppState: vi.fn(async (p: { key: string }) => {
        if (p.key === "arrangement_by_scope" && takeArrangementGetFailure())
          throw new Error("boot flake");
        return appState.get(p.key) ?? null;
      }),
      setAppState: vi.fn(async (p: { key: string; value: string | null }) => {
        setAppStateCalls.push(p);
        if (p.value === null) appState.delete(p.key);
        else appState.set(p.key, p.value);
        return true;
      }),
      groupsList: vi.fn(async () => []),
      tabsList: vi.fn(async (p: { directoryId?: string }) => {
        tabsListCalls.push(p.directoryId);
        const deferred = getTabsListDeferred();
        if (deferred) return deferred.promise;
        return p.directoryId ? tabsListByDir[p.directoryId] ?? [] : Object.values(tabsListByDir).flat();
      }),
      getDirectories: vi.fn(async () => getDirectoriesResult()),
      getAgentStates: vi.fn(async () => agentStates),
      deleteDirectory: vi.fn(async () => true),
      gitCheckoutBranch: rpc.gitCheckoutBranch,
      worktreeCreate: rpc.worktreeCreate,
      worktreeRemove: rpc.worktreeRemove,
      tabsCreate: rpc.tabsCreate,
      tabsClose: vi.fn(async (p: { id: string }) => {
        tabsClosedIds.push(p.id);
        return true;
      }),
      tabsSessionId: vi.fn(async (p: { id: string }) => {
        tabsSessionIdCalls.push(p.id);
        return null;
      }),
      tabsArchive: vi.fn(async (p: { id: string }) => {
        tabsArchiveCalls.push(p.id);
        return tabsArchiveNext;
      }),
      tabsUnarchive: vi.fn(async (p: { id: string; resume: boolean }) => {
        tabsUnarchiveCalls.push(p);
        return tabsUnarchiveNext;
      }),
      tabsReorder: vi.fn(async () => true),
      listLiveTabIds: vi.fn(async () => getLiveTabIds()),
      setActiveDirectory: vi.fn(async () => true),
      prewarmFileIndex: vi.fn(async () => true),
    },
  }),
}));

import { useWorkspaceStore } from "./workspace";
import { collectPaneIds, nodeKey } from "@/lib/paneLayout";
import { bottomSurfaceKey } from "@/lib/bottomPanel";

function lastArrangementWrite() {
  const writes = setAppStateCalls.filter((c) => c.key === "arrangement_by_scope");
  return writes.at(-1);
}

function parsedArrangement(dirId: string) {
  const write = lastArrangementWrite();
  expect(write).toBeTruthy();
  const parsed = JSON.parse(write!.value!);
  return parsed[dirId];
}

describe("workspace store arrangement writes (slice 2: arrangements own writes)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    tabsSessionIdCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("newSession writes a solo layout for the new tab", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    expect(parsedArrangement("dir-1")).toEqual({ version: 1, layout: { pane: tab.id } });
  });

  it("createTab is a compat alias for newSession", async () => {
    const store = useWorkspaceStore();
    const tab = await store.createTab({ directoryId: "dir-1" });
    expect(parsedArrangement("dir-1")).toEqual({ version: 1, layout: { pane: tab.id } });
  });

  it("splitSessionWithNew inserts the new session beside the anchor", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    setAppStateCalls.length = 0;

    await store.splitSessionWithNew(tab1.id, "h");

    const arr = parsedArrangement("dir-1");
    const newId = arr.layout.children.find((c: { pane: string }) => c.pane !== tab1.id).pane;
    expect(arr).toEqual({
      version: 1,
      layout: { direction: "h", children: [{ pane: tab1.id }, { pane: newId }], sizes: [50, 50] },
    });
  });

  it("splitSessionWithExisting rearranges two sessions already in the same scope", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    await store.splitSessionWithNew(tab1.id, "h");
    const arrBefore = parsedArrangement("dir-1");
    const tab2Id = arrBefore.layout.children.find((c: { pane: string }) => c.pane !== tab1.id).pane;
    setAppStateCalls.length = 0;

    store.splitSessionWithExisting(tab1.id, tab2Id, "v", true);

    expect(parsedArrangement("dir-1")).toEqual({
      version: 1,
      layout: { direction: "v", children: [{ pane: tab2Id }, { pane: tab1.id }], sizes: [50, 50] },
    });
  });

  it("splitSessionWithExisting is a no-op across scopes", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    const tab2 = await store.newSession("dir-2");
    setAppStateCalls.length = 0;

    store.splitSessionWithExisting(tab1.id, tab2.id, "h");

    expect(lastArrangementWrite()).toBeUndefined();
  });

  it("removeFromView drops a session from its scope's arrangement without closing its PTY", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    await store.splitSessionWithNew(tab1.id, "h");
    const arrBefore = parsedArrangement("dir-1");
    const tab2Id = arrBefore.layout.children.find((c: { pane: string }) => c.pane !== tab1.id).pane;
    setAppStateCalls.length = 0;

    store.removeFromView(tab2Id);

    expect(parsedArrangement("dir-1")).toEqual({ version: 1, layout: { pane: tab1.id } });
    expect(tabsClosedIds).toEqual([]);
  });

  it("closeSession kills the PTY and removes the session from the arrangement", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    await store.splitSessionWithNew(tab1.id, "h");
    const arrBefore = parsedArrangement("dir-1");
    const tab2Id = arrBefore.layout.children.find((c: { pane: string }) => c.pane !== tab1.id).pane;
    setAppStateCalls.length = 0;

    await store.closeSession(tab2Id);

    expect(tabsClosedIds).toEqual([tab2Id]);
    expect(parsedArrangement("dir-1")).toEqual({ version: 1, layout: { pane: tab1.id } });
    expect(store.terminalTabsByDirectory["dir-1"]?.some((t) => t.id === tab2Id)).toBe(false);
  });

  it("setArrangementSizes writes sizes into the matching internal node", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    await store.splitSessionWithNew(tab1.id, "h");
    const arr = store.arrangementByScope["dir-1"];
    setAppStateCalls.length = 0;

    store.setArrangementSizes("dir-1", nodeKey(arr.layout), [30, 70]);

    expect(parsedArrangement("dir-1").layout.sizes).toEqual([30, 70]);
  });

  it("arrangementFor reads back what was written", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    expect(store.arrangementFor("dir-1")).toEqual({ version: 1, layout: { pane: tab.id } });
    expect(store.arrangementFor("no-such-dir")).toBeNull();
  });

  it("concurrent newSession calls in one directory both land (no lost update)", async () => {
    const store = useWorkspaceStore();
    const d1 = queueTabsCreateDeferred();
    const d2 = queueTabsCreateDeferred();

    const p1 = store.newSession("dir-1");
    const p2 = store.newSession("dir-1");

    // Resolve out of order: the second call's tabsCreate completes first.
    d2.resolve();
    const tab2 = await p2;
    d1.resolve();
    const tab1 = await p1;

    const ids = (store.terminalTabsByDirectory["dir-1"] ?? []).map((t) => t.id);
    expect(ids.sort()).toEqual([tab1.id, tab2.id].sort());
  });

  it("closeSession on a non-focused session leaves focus untouched", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    await store.splitSessionWithNew(tab1.id, "h");
    const arrBefore = parsedArrangement("dir-1");
    const tab2Id = arrBefore.layout.children.find((c: { pane: string }) => c.pane !== tab1.id).pane;
    store.selectDirectory({ id: "dir-1", path: "/dir-1", name: "dir-1", createdAt: 0, sortOrder: 0 });
    store.focusSession(tab1.id);
    setAppStateCalls.length = 0;

    await store.closeSession(tab2Id);

    expect(store.focusedSessionId).toBe(tab1.id);
  });
});

describe("workspace store session lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    tabsSessionIdCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("hydrateSessionLifecycle marks live ids running and others exited", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    const tab2 = await store.splitSessionWithNew(tab1.id, "h").then(() => {
      const arr = store.arrangementByScope["dir-1"];
      return collectPaneIds(arr.layout).find((id) => id !== tab1.id) as string;
    });
    setLiveTabIds([tab1.id]);

    await store.hydrateSessionLifecycle();

    expect(store.sessionLifecycle.get(tab1.id)).toBe("running");
    expect(store.sessionLifecycle.get(tab2)).toBe("exited");
  });

  it("a later hydrate re-syncs a stale entry (snapshot wins, not first-write-wins)", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    setLiveTabIds([tab1.id]);
    await store.hydrateSessionLifecycle();
    expect(store.sessionLifecycle.get(tab1.id)).toBe("running");

    // Tab exits but no event lands (missed hook). A later hydrate on the
    // same directory must re-sync it to exited, not skip it forever.
    setLiveTabIds([]);
    await store.hydrateSessionLifecycle();

    expect(store.sessionLifecycle.get(tab1.id)).toBe("exited");
  });

  it("a live event during an in-flight hydrate survives the (older) snapshot", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    setLiveTabIdsDeferred();

    const hydrate = store.hydrateSessionLifecycle();
    store.markSessionExited(tab1.id);
    resolveLiveTabIdsDeferred([tab1.id]);
    await hydrate;

    expect(store.sessionLifecycle.get(tab1.id)).toBe("exited");
  });

  it("concurrent hydrates don't clobber each other, and an event during both survives", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    const tab2 = await store.newSession("dir-1");

    const d1 = queueLiveTabIdsDeferred();
    const d2 = queueLiveTabIdsDeferred();

    const hydrateA = store.hydrateSessionLifecycle();
    const hydrateB = store.hydrateSessionLifecycle();

    // Event lands while BOTH hydrates are in flight.
    store.markSessionExited(tab1.id);

    // Resolve out of order: second call's promise first.
    d2.resolve([tab1.id, tab2.id]);
    d1.resolve([tab2.id]);
    await Promise.all([hydrateA, hydrateB]);

    // tab1's live event must survive both snapshots even though each
    // snapshot disagreed about tab1 (one said live, one didn't mention it).
    expect(store.sessionLifecycle.get(tab1.id)).toBe("exited");
    expect(store.sessionLifecycle.get(tab2.id)).toBe("running");
  });
});

const dir = (id: string) => ({ id, path: `/${id}`, name: id, createdAt: 0, sortOrder: 0 });

describe("exited-close skip (I4), focus persistence (I5), label threading (I6)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    tabsSessionIdCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("closeSession of an exited session skips tabsSessionId (no pointless respawn)", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    store.markSessionExited(tab.id);

    await store.closeSession(tab.id);

    expect(tabsSessionIdCalls).not.toContain(tab.id);
    expect(tabsClosedIds).toEqual([tab.id]);
  });

  it("closeSession of a live session still resolves tabsSessionId before tabsClose", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");

    await store.closeSession(tab.id);

    expect(tabsSessionIdCalls).toContain(tab.id);
    expect(tabsClosedIds).toEqual([tab.id]);
  });

  it("focusSession persists focused_by_scope, short-circuiting same-value writes", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1"); // focuses internally
    const writes = () => setAppStateCalls.filter((c) => c.key === "focused_by_scope");
    expect(JSON.parse(writes().at(-1)!.value!)).toEqual({ "dir-1": tab.id });
    const count = writes().length;

    store.focusSession(tab.id); // same value → no new write

    expect(writes().length).toBe(count);
  });

  it("hydrates focused_by_scope so focus survives relaunch", async () => {
    appState.set("focused_by_scope", JSON.stringify({ "dir-1": "tab-a" }));
    appState.set(
      "arrangement_by_scope",
      JSON.stringify({ "dir-1": { version: 1, layout: { direction: "h", children: [{ pane: "tab-a" }, { pane: "tab-b" }], sizes: [50, 50] } } }),
    );
    appState.set("layout_model:dir-1", "2");
    tabsListByDir["dir-1"] = [
      { id: "tab-a", directoryId: "dir-1", label: "1", cwd: null },
      { id: "tab-b", directoryId: "dir-1", label: "2", cwd: null },
    ];

    const store = useWorkspaceStore();
    store.selectDirectory(dir("dir-1"));
    await store.loadTabsForDirectory("dir-1");

    expect(store.focusedSessionId).toBe("tab-a");
  });

  it("drops a hydrated focus id once tabs load and it no longer names a live session", async () => {
    // "tab-a" was focused at persist time but has since been closed elsewhere
    // (e.g. another window) — tabsList no longer returns it.
    appState.set("focused_by_scope", JSON.stringify({ "dir-1": "tab-a" }));
    appState.set("layout_model:dir-1", "2");
    tabsListByDir["dir-1"] = [{ id: "tab-b", directoryId: "dir-1", label: "1", cwd: null }];

    const store = useWorkspaceStore();
    store.selectDirectory(dir("dir-1"));
    await store.loadTabsForDirectory("dir-1");

    expect(store.focusedSessionId).not.toBe("tab-a");
  });

  it("createTab threads an explicit label through newSession", async () => {
    const store = useWorkspaceStore();
    const tab = await store.createTab({ directoryId: "dir-1", label: "Suggested changes" });
    expect(tab.label).toBe("Suggested changes");
    // Default stays the numbered fallback.
    const tab2 = await store.newSession("dir-1");
    expect(tab2.label).toBe("2");
  });
});

describe("new-session picker", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    tabsCreateCalls.length = 0;
    appState.clear();
    setDirectoriesResult([]);
    for (const key of Object.keys(tabsListByDir)) delete tabsListByDir[key];
  });

  it("opens and closes for the selected directory without creating a tab", () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
    expect(tabsCreateCalls).toEqual([]);
    store.closeSessionPicker();
    expect(store.pendingPicker).toBeNull();
  });

  it("does nothing when no workspace directory exists", () => {
    const store = useWorkspaceStore();
    store.openSessionPicker();
    expect(store.pendingPicker).toBeNull();
  });

  it("loading an empty selected directory opens the picker without a tab", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    store.selectDirectory(dir("dir-1"));
    await store.loadTabsForDirectory("dir-1");
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
    expect(store.terminalTabsByDirectory["dir-1"]).toEqual([]);
    expect(tabsCreateCalls).toEqual([]);
  });

  it("shares one in-flight tabs load and its result across concurrent callers", async () => {
    tabsListCalls.length = 0;
    const store = useWorkspaceStore();
    const deferred = queueTabsListDeferred();
    const loadedTab = { id: "tab-a", directoryId: "dir-1", label: "1", cwd: null };

    const first = store.loadTabsForDirectory("dir-1");
    const second = store.loadTabsForDirectory("dir-1");
    deferred.resolve([loadedTab]);
    const [firstTabs, secondTabs] = await Promise.all([first, second]);

    expect(tabsListCalls).toEqual(["dir-1"]);
    expect(firstTabs).toEqual([loadedTab]);
    expect(secondTabs).toBe(firstTabs);
  });

  it("shares an in-flight tabs load failure and evicts it for retry", async () => {
    tabsListCalls.length = 0;
    const store = useWorkspaceStore();
    const deferred = queueTabsListDeferred();
    const failure = new Error("tabs unavailable");

    const first = store.loadTabsForDirectory("dir-1");
    const second = store.loadTabsForDirectory("dir-1");
    deferred.reject(failure);
    const results = await Promise.allSettled([first, second]);

    expect(tabsListCalls).toEqual(["dir-1"]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);

    tabsListByDir["dir-1"] = [];
    await store.loadTabsForDirectory("dir-1");
    expect(tabsListCalls).toEqual(["dir-1", "dir-1"]);
  });

  it("preserves a session created while an older empty tabs load is pending", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    store.selectDirectory(dir("dir-1"));
    const deferred = queueTabsListDeferred();

    const load = store.loadTabsForDirectory("dir-1");
    const tab = await store.newSession("dir-1");
    deferred.resolve([]);
    await load;

    expect(store.terminalTabsByDirectory["dir-1"]).toEqual([tab]);
    expect(store.pendingPicker).toBeNull();
  });

  it("opens the picker when directories hydrate after the selected empty scope", async () => {
    localStorage.setItem("selectedDirectoryId", "dir-1");
    setDirectoriesResult([dir("dir-1")]);
    const store = useWorkspaceStore();

    await store.loadTabsForDirectory("dir-1");
    expect(store.pendingPicker).toBeNull();

    await store.fetchDirectories();

    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
  });

  it("closing the last selected session opens the picker", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    const tab = await store.newSession("dir-1");
    store.selectDirectory(dir("dir-1"));
    store.closeSessionPicker();
    await store.closeSession(tab.id);
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
    expect(store.terminalTabsByDirectory["dir-1"]).toEqual([]);
    expect(store.activeTabIdByDirectory["dir-1"]).toBeUndefined();
    expect(store.focusedSessionId).toBeUndefined();
  });

  it("retargets on scope selection and dismisses on session selection", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"), dir("dir-2"));
    const tab = await store.newSession("dir-2");
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    store.selectDirectory(dir("dir-2"));
    expect(store.pendingPicker).toEqual({ dirId: "dir-2" });
    store.selectSession(tab.id);
    expect(store.pendingPicker).toBeNull();
  });

  it("threads agentLaunch through createTab without a launchCommand", async () => {
    const store = useWorkspaceStore();
    await store.createTab({
      directoryId: "dir-1",
      agentLaunch: { agentType: "claude", modelId: "sonnet", effort: "medium", fast: null },
    });
    expect(tabsCreateCalls.at(-1)).toMatchObject({
      directoryId: "dir-1",
      agentLaunch: { agentType: "claude", modelId: "sonnet", effort: "medium", fast: null },
    });
    expect(tabsCreateCalls.at(-1)).not.toHaveProperty("launchCommand");
  });
});

describe("picker launch orchestration", () => {
  const mainBranch = { name: "main", fullRef: "refs/heads/main", isRemote: false, isHead: false };
  const remoteBranch = { name: "origin/feature", fullRef: "refs/remotes/origin/feature", isRemote: true, isHead: false };

  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    tabsCreateCalls.length = 0;
    nextId = 0;
    rpc.gitCheckoutBranch.mockClear();
    rpc.worktreeCreate.mockClear();
    rpc.worktreeRemove.mockClear();
    rpc.tabsCreate.mockClear();
    filePanel.dropFilePanelScope.mockClear();
  });

  afterEach(() => {
    rpc.gitCheckoutBranch.mockReset();
    rpc.worktreeCreate.mockReset();
    rpc.worktreeCreate.mockResolvedValue({
      id: "wt-new",
      path: "/wt-new",
      name: "wt-new",
      createdAt: 0,
      sortOrder: 1,
      parentDirectoryId: "dir-1",
    });
    rpc.worktreeRemove.mockReset();
    rpc.worktreeRemove.mockResolvedValue(true);
    rpc.tabsCreate.mockReset();
    rpc.tabsCreate.mockImplementation(defaultTabsCreate);
    filePanel.dropFilePanelScope.mockReset();
  });

  it("checks out the selected current branch before launch", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));

    await store.startPickerSession({
      directoryId: "dir-1",
      mode: "current",
      branch: remoteBranch,
      agentLaunch: { agentType: "claude", modelId: "sonnet", effort: "medium", fast: null },
    });

    expect(rpc.gitCheckoutBranch).toHaveBeenCalledWith({
      path: "/dir-1",
      name: "origin/feature",
      isRemote: true,
      remoteRef: "origin/feature",
    });
    expect(rpc.gitCheckoutBranch.mock.invocationCallOrder[0])
      .toBeLessThan(rpc.tabsCreate.mock.invocationCallOrder[0]);
    expect(rpc.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({ directoryId: "dir-1" }));
  });

  it("skips checkout for the branch already at HEAD", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));

    await store.startPickerSession({
      directoryId: "dir-1",
      mode: "current",
      branch: { ...mainBranch, isHead: true },
    });

    expect(rpc.gitCheckoutBranch).not.toHaveBeenCalled();
    expect(rpc.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({ directoryId: "dir-1" }));
  });

  it("creates a sibling worktree from the selected ref", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"), { ...dir("wt-1"), parentDirectoryId: "dir-1" });

    await store.startPickerSession({ directoryId: "wt-1", mode: "worktree", branch: mainBranch });

    expect(rpc.worktreeCreate).toHaveBeenCalledWith({
      parentDirectoryId: "dir-1",
      branch: "",
      baseRef: "main",
    });
    expect(rpc.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({ directoryId: "wt-new" }));
    expect(store.selectedDirectoryId).toBe("wt-new");
  });

  it("keeps the original picker mounted until the worktree session launches", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    const deferred = queueTabsCreateDeferred();

    const launch = store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch });
    await vi.waitFor(() => expect(rpc.tabsCreate).toHaveBeenCalled());

    expect(store.selectedDirectoryId).toBe("dir-1");
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });

    deferred.resolve();
    await launch;
    expect(store.selectedDirectoryId).toBe("wt-new");
    expect(store.pendingPicker).toBeNull();
  });

  it("does not clobber newer navigation when the worktree session launches", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"), dir("dir-2"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    const deferred = queueTabsCreateDeferred();

    const launch = store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch });
    await vi.waitFor(() => expect(rpc.tabsCreate).toHaveBeenCalled());
    store.selectDirectory(dir("dir-2"));

    deferred.resolve();
    await launch;
    expect(store.selectedDirectoryId).toBe("dir-2");
    expect(store.pendingPicker).toEqual({ dirId: "dir-2" });
  });

  it("resolves nested linked directories to their root for worktree creation", async () => {
    const store = useWorkspaceStore();
    store.directories.push(
      dir("dir-1"),
      { ...dir("wt-1"), parentDirectoryId: "dir-1" },
      { ...dir("wt-2"), parentDirectoryId: "wt-1" },
    );

    await store.startPickerSession({ directoryId: "wt-2", mode: "worktree", branch: remoteBranch });

    expect(rpc.worktreeCreate).toHaveBeenCalledWith({
      parentDirectoryId: "dir-1",
      branch: "",
      baseRef: "origin/feature",
    });
  });

  it("rolls back only a new worktree when PTY creation fails", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"), { ...dir("wt-existing"), parentDirectoryId: "dir-1" });
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    rpc.tabsCreate.mockRejectedValueOnce(new Error("spawn failed"));

    await expect(store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch }))
      .rejects.toThrow("spawn failed");

    expect(rpc.worktreeRemove).toHaveBeenCalledWith({ id: "wt-new", force: true });
    expect(filePanel.dropFilePanelScope).toHaveBeenCalledWith("wt-new");
    expect(store.directories.map((directory) => directory.id)).toEqual(["dir-1", "wt-existing"]);
    expect(store.selectedDirectoryId).toBe("dir-1");
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
  });

  it("does not overwrite a newer selection or picker target during rollback", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"), dir("dir-2"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    let rejectCreate!: (error: Error) => void;
    rpc.tabsCreate.mockImplementationOnce(async (opts) => {
      tabsCreateCalls.push({ ...opts });
      await new Promise<void>((_, reject) => {
        rejectCreate = reject;
      });
      throw new Error("unreachable");
    });

    const launch = store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch });
    await vi.waitFor(() => expect(rpc.tabsCreate).toHaveBeenCalled());
    store.selectDirectory(dir("dir-2"));
    rejectCreate(new Error("spawn failed"));

    await expect(launch).rejects.toThrow("spawn failed");
    expect(store.selectedDirectoryId).toBe("dir-2");
    expect(store.pendingPicker).toEqual({ dirId: "dir-2" });
  });

  it("falls back to a live selection after the user returns to the created worktree", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"), dir("dir-2"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    let rejectCreate!: (error: Error) => void;
    rpc.tabsCreate.mockImplementationOnce(async (opts) => {
      tabsCreateCalls.push({ ...opts });
      await new Promise<void>((_, reject) => {
        rejectCreate = reject;
      });
      throw new Error("unreachable");
    });

    const launch = store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch });
    await vi.waitFor(() => expect(rpc.tabsCreate).toHaveBeenCalled());
    store.selectDirectory(dir("dir-2"));
    store.selectDirectory(store.directories.find((directory) => directory.id === "wt-new")!);
    rejectCreate(new Error("spawn failed"));

    await expect(launch).rejects.toThrow("spawn failed");
    expect(store.selectedDirectoryId).toBe("dir-1");
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
  });

  it("falls back to a live picker target after the picker returns to the created worktree", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"), dir("dir-2"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    let rejectCreate!: (error: Error) => void;
    rpc.tabsCreate.mockImplementationOnce(async (opts) => {
      tabsCreateCalls.push({ ...opts });
      await new Promise<void>((_, reject) => {
        rejectCreate = reject;
      });
      throw new Error("unreachable");
    });

    const launch = store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch });
    await vi.waitFor(() => expect(rpc.tabsCreate).toHaveBeenCalled());
    store.openSessionPicker("dir-2");
    store.openSessionPicker("wt-new");
    rejectCreate(new Error("spawn failed"));

    await expect(launch).rejects.toThrow("spawn failed");
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
  });

  it("restores the selection that was current when the created worktree took focus", async () => {
    const store = useWorkspaceStore();
    const created = { ...dir("wt-new"), parentDirectoryId: "dir-1" };
    store.directories.push(dir("dir-1"), dir("dir-2"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    let resolveWorktree!: (directory: typeof created) => void;
    rpc.worktreeCreate.mockImplementationOnce(() => new Promise<typeof created>((resolve) => {
      resolveWorktree = resolve;
    }));
    rpc.tabsCreate.mockRejectedValueOnce(new Error("spawn failed"));

    const launch = store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch });
    await vi.waitFor(() => expect(rpc.worktreeCreate).toHaveBeenCalled());
    store.selectDirectory(dir("dir-2"));
    resolveWorktree(created);

    await expect(launch).rejects.toThrow("spawn failed");
    expect(store.selectedDirectoryId).toBe("dir-2");
    expect(store.pendingPicker).toEqual({ dirId: "dir-2" });
  });

  it("keeps the spawn failure visible when rollback also fails", async () => {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    store.selectDirectory(dir("dir-1"));
    store.openSessionPicker();
    rpc.tabsCreate.mockRejectedValueOnce(new Error("spawn failed"));
    rpc.worktreeRemove.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(store.startPickerSession({ directoryId: "dir-1", mode: "worktree", branch: mainBranch }))
      .rejects.toThrow(/spawn failed.*cleanup failed/);
    expect(store.directories.map((directory) => directory.id)).toEqual(["dir-1", "wt-new"]);
    expect(filePanel.dropFilePanelScope).not.toHaveBeenCalled();
    expect(store.selectedDirectoryId).toBe("dir-1");
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
  });
});

describe("hydrate-failure guard", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("skips prune/backfill writes until hydration succeeds, then retries", async () => {
    appState.set("layout_model:dir-1", "2");
    tabsListByDir["dir-1"] = [
      { id: "tab-a", directoryId: "dir-1", label: "1", cwd: null },
    ];
    setFailArrangementGets(1);

    const store = useWorkspaceStore();
    await store.loadTabsForDirectory("dir-1");
    // Hydration failed → no arrangement write may be persisted (a partial map
    // would clobber other scopes' arrangements).
    expect(lastArrangementWrite()).toBeUndefined();

    // Next load retries hydration (memo cleared) and backfills.
    await store.loadTabsForDirectory("dir-1");
    expect(parsedArrangement("dir-1")).toEqual({ version: 1, layout: { pane: "tab-a" } });
  });
});

describe("dead-scope sweep (M9)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("deleteDirectory clears the tab bucket, lifecycle entries, and persisted arrangement", async () => {
    const store = useWorkspaceStore();
    const keep = await store.newSession("dir-keep");
    const tab = await store.newSession("dir-1");
    store.markSessionRunning(tab.id);
    setAppStateCalls.length = 0;

    await store.deleteDirectory("dir-1");

    expect(store.terminalTabsByDirectory["dir-1"]).toBeUndefined();
    expect(store.sessionLifecycle.get(tab.id)).toBeUndefined();
    const write = lastArrangementWrite();
    expect(write).toBeTruthy();
    const map = JSON.parse(write!.value!);
    expect(map["dir-1"]).toBeUndefined();
    expect(map["dir-keep"]).toEqual({ version: 1, layout: { pane: keep.id } });
  });

  it("removeWorktree sweeps the removed subtree's scopes", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("wt-1");
    store.markSessionRunning(tab.id);
    setAppStateCalls.length = 0;

    await store.removeWorktree("wt-1");

    expect(store.terminalTabsByDirectory["wt-1"]).toBeUndefined();
    expect(store.sessionLifecycle.get(tab.id)).toBeUndefined();
    expect(JSON.parse(lastArrangementWrite()!.value!)["wt-1"]).toBeUndefined();
  });
});

describe("sessionActivityAt snapshot", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    agentStates.length = 0;
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies reactive consumers on activity stamps and deletion", async () => {
    const store = useWorkspaceStore();
    const seen: number[] = [];
    const stop = watch(() => store.activityVersion, (version) => seen.push(version), { flush: "sync" });

    const tab = await store.newSession("dir-1");
    expect(seen.length).toBeGreaterThan(0);
    const afterCreate = seen.at(-1)!;

    store.applyTabUpdate({
      tabId: tab.id,
      agentType: "claude",
      agentState: "working",
      revision: 1,
      changedAt: 123,
    } as never);
    expect(seen.at(-1)).toBe(afterCreate + 1);

    await store.closeSession(tab.id);
    expect(seen.at(-1)).toBe(afterCreate + 2);
    stop();
  });

  it("hydrates only missing activity with lastOutputAt, changedAt, then zero", async () => {
    agentStates.push(
      {
        tabId: "output",
        agentType: "claude",
        agentState: "idle",
        revision: 1,
        lastOutputAt: 30,
        changedAt: 20,
      },
      { tabId: "changed", agentType: "claude", agentState: "idle", revision: 1, changedAt: 20 },
      { tabId: "never", agentType: "claude", agentState: "idle", revision: 1 },
    );

    const store = useWorkspaceStore();
    await store.loadAllTabs();

    await vi.waitFor(() => {
      expect(store.sessionActivityAt.get("output")).toBe(30);
      expect(store.sessionActivityAt.get("changed")).toBe(20);
      expect(store.sessionActivityAt.get("never")).toBe(0);
    });
  });

  it("hydration never overwrites existing activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    expect(store.sessionActivityAt.get(tab.id)).toBe(100);
    agentStates.push({
      tabId: tab.id,
      agentType: "claude",
      agentState: "idle",
      revision: 1,
    });

    vi.setSystemTime(999);
    await store.loadAllTabs();

    await vi.waitFor(() => {
      expect(store.tabRuntime.get(tab.id)?.agentType).toBe("claude");
      expect(store.sessionActivityAt.get(tab.id)).toBe(100);
    });
  });

  it("stamps on creation, not on selection or plain status updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const store = useWorkspaceStore();
    store.directories = [dir("dir-1")];
    const tab = await store.newSession("dir-1");
    const created = store.sessionActivityAt.get(tab.id);
    expect(created).toBeTypeOf("number");

    // plain status flicker: same agentType (none), state change only
    store.applyTabUpdate({ tabId: tab.id, agentState: "working", revision: 5 } as never);
    expect(store.sessionActivityAt.get(tab.id)).toBe(created);

    // agent-type change IS a discrete event
    store.applyTabUpdate({ tabId: tab.id, agentType: "claude", agentState: "working", revision: 6, changedAt: 12345 } as never);
    expect(store.sessionActivityAt.get(tab.id)).toBe(12345);

    // selection does NOT re-stamp (cards must not reshuffle on click)
    vi.setSystemTime(200);
    store.selectSession(tab.id);
    expect(store.sessionActivityAt.get(tab.id)).toBe(12345);
  });

  it("clears on close", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    await store.closeSession(tab.id);
    expect(store.sessionActivityAt.get(tab.id)).toBeUndefined();
  });
});

describe("archive session lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    tabsSessionIdCalls.length = 0;
    tabsArchiveCalls.length = 0;
    tabsArchiveNext = null;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("archiveSession calls tabsArchive once and replaces the tab without disturbing its arrangement leaf", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    const arrBefore = store.arrangementByScope["dir-1"];
    setAppStateCalls.length = 0;
    setTabsArchiveResult({ ...tab, archivedAt: 111 });

    await store.archiveSession(tab.id);

    expect(tabsArchiveCalls).toEqual([tab.id]);
    expect(store.terminalTabsByDirectory["dir-1"]?.find((t) => t.id === tab.id)?.archivedAt).toBe(111);
    expect(store.arrangementByScope["dir-1"]).toEqual(arrBefore);
    expect(lastArrangementWrite()).toBeUndefined();
    expect(tabsSessionIdCalls).not.toContain(tab.id);
    expect(tabsClosedIds).not.toContain(tab.id);
  });

  it("hydrateSessionLifecycle skips archived tabs instead of marking them exited", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    setTabsArchiveResult({ ...tab, archivedAt: 111 });
    await store.archiveSession(tab.id);

    setLiveTabIds([]);
    await store.hydrateSessionLifecycle();

    expect(store.sessionLifecycle.has(tab.id)).toBe(false);
  });

  it("applying a duplicate archive local-response/event is idempotent", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    const archivedTab = { ...tab, archivedAt: 222 };

    store.applyArchivedTab(archivedTab);
    store.applyArchivedTab(archivedTab);
    window.dispatchEvent(new CustomEvent("tab-archived", { detail: { tab: archivedTab } }));

    const matches = store.terminalTabsByDirectory["dir-1"]?.filter((t) => t.id === tab.id) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0].archivedAt).toBe(222);
    expect(store.sessionLifecycle.has(tab.id)).toBe(false);
  });

  it("a tab-archived window event updates the store without a local archiveSession call", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");

    window.dispatchEvent(new CustomEvent("tab-archived", { detail: { tab: { ...tab, archivedAt: 333 } } }));

    expect(store.terminalTabsByDirectory["dir-1"]?.find((t) => t.id === tab.id)?.archivedAt).toBe(333);
  });

  it("closing/deleting an archived tab closes the PTY directly and never respawns it", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    store.applyArchivedTab({ ...tab, archivedAt: 444 });

    await store.closeSession(tab.id);

    expect(tabsSessionIdCalls).not.toContain(tab.id);
    expect(tabsClosedIds).toEqual([tab.id]);
  });
});

describe("unarchive session lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    tabsSessionIdCalls.length = 0;
    tabsArchiveCalls.length = 0;
    tabsArchiveNext = null;
    tabsUnarchiveCalls.length = 0;
    tabsUnarchiveNext = null;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("unarchiveSession calls tabsUnarchive with resume, applies the live tab, marks it running", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    store.applyArchivedTab({ ...tab, archivedAt: 111 });
    setTabsUnarchiveResult({ ...tab, archivedAt: undefined });

    await store.unarchiveSession(tab.id, true);

    expect(tabsUnarchiveCalls).toEqual([{ id: tab.id, resume: true }]);
    expect(store.terminalTabsByDirectory["dir-1"]?.find((t) => t.id === tab.id)?.archivedAt).toBeUndefined();
    expect(store.sessionLifecycle.get(tab.id)).toBe("running");
  });

  it("applyUnarchivedTab is idempotent (single tab, running lifecycle)", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    store.applyArchivedTab({ ...tab, archivedAt: 222 });
    const live = { ...tab, archivedAt: undefined };

    store.applyUnarchivedTab(live);
    store.applyUnarchivedTab(live);
    window.dispatchEvent(new CustomEvent("tab-unarchived", { detail: { tab: live } }));

    const matches = store.terminalTabsByDirectory["dir-1"]?.filter((t) => t.id === tab.id) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0].archivedAt).toBeUndefined();
    expect(store.sessionLifecycle.get(tab.id)).toBe("running");
  });

  it("a tab-unarchived window event updates the store without a local unarchiveSession call", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    store.applyArchivedTab({ ...tab, archivedAt: 333 });

    window.dispatchEvent(new CustomEvent("tab-unarchived", { detail: { tab: { ...tab, archivedAt: undefined } } }));

    expect(store.terminalTabsByDirectory["dir-1"]?.find((t) => t.id === tab.id)?.archivedAt).toBeUndefined();
    expect(tabsUnarchiveCalls).toEqual([]);
  });
});

describe("surface keys (bottom panel groundwork)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("resolves a center session to its directory id", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    expect(store.surfaceKeyFor(tab.id)).toBe("dir-1");
  });

  it("resolves a session in a bottom surface to that surface key", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    const key = bottomSurfaceKey("dir-1", "bt-1");
    store.writeArrangement("dir-1", null);
    store.writeArrangement(key, { version: 1, layout: { pane: tab.id } });
    expect(store.surfaceKeyFor(tab.id)).toBe(key);
  });

  it("splits inside a bottom surface without touching the center arrangement", async () => {
    const store = useWorkspaceStore();
    const centerTab = await store.newSession("dir-1");
    const bottomTab = await store.newSession("dir-1"); // becomes the bottom pane below
    const key = bottomSurfaceKey("dir-1", "bt-1");
    store.writeArrangement("dir-1", { version: 1, layout: { pane: centerTab.id } });
    store.writeArrangement(key, { version: 1, layout: { pane: bottomTab.id } });

    await store.splitSessionWithNew(bottomTab.id, "h");

    expect(store.arrangementByScope["dir-1"]).toEqual({ version: 1, layout: { pane: centerTab.id } });
    const panes = collectPaneIds(store.arrangementByScope[key].layout);
    expect(panes).toHaveLength(2);
    expect(panes).toContain(bottomTab.id);
  });

  it("focusing a bottom session does not move center focus", async () => {
    const store = useWorkspaceStore();
    const centerTab = await store.newSession("dir-1");
    const bottomTab = await store.newSession("dir-1");
    store.writeArrangement("dir-1", { version: 1, layout: { pane: centerTab.id } });
    store.writeArrangement(bottomSurfaceKey("dir-1", "bt-1"), {
      version: 1,
      layout: { pane: bottomTab.id },
    });
    store.selectedDirectoryId = "dir-1";
    store.focusSession(centerTab.id);

    store.focusSession(bottomTab.id);

    expect(store.activeTabIdByDirectory["dir-1"]).toBe(centerTab.id);
    expect(store.activeSurface).toBe("bottom");
  });

  it("removeFromView drops a pane from its own bottom surface", async () => {
    const store = useWorkspaceStore();
    const a = await store.newSession("dir-1");
    const key = bottomSurfaceKey("dir-1", "bt-1");
    store.writeArrangement(key, { version: 1, layout: { pane: a.id } });
    await store.splitSessionWithNew(a.id, "v");
    const other = collectPaneIds(store.arrangementByScope[key].layout).find((id) => id !== a.id)!;

    store.removeFromView(other);

    expect(collectPaneIds(store.arrangementByScope[key].layout)).toEqual([a.id]);
  });

  it("detachFromSurface removes the pane and deletes an emptied surface", async () => {
    const store = useWorkspaceStore();
    const tab = await store.newSession("dir-1");
    const key = bottomSurfaceKey("dir-1", "bt-1");
    store.writeArrangement(key, { version: 1, layout: { pane: tab.id } });

    store.detachFromSurface(key, tab.id);

    expect(store.arrangementByScope[key]).toBeUndefined();
  });
});

describe("bottom terminal panel", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    tabsCreateCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  async function withDir() {
    const store = useWorkspaceStore();
    store.directories.push(dir("dir-1"));
    store.selectDirectory(dir("dir-1"));
    return store;
  }

  it("createBottomTerminal spawns in the scope cwd and opens a bottom surface", async () => {
    const store = await withDir();
    const tab = await store.createBottomTerminal("dir-1");
    expect(tab).toBeTruthy();
    expect(tabsCreateCalls.at(-1)).toMatchObject({ directoryId: "dir-1", cwd: "/dir-1" });
    const state = store.bottomPanelFor("dir-1")!;
    expect(state.tabs).toHaveLength(1);
    expect(state.collapsed).toBe(false);
    const key = bottomSurfaceKey("dir-1", state.tabs[0]);
    expect(store.arrangementByScope[key]).toEqual({ version: 1, layout: { pane: tab!.id } });
  });

  it("keeps bottom terminals out of the center arrangement and the sessions list", async () => {
    const store = await withDir();
    const bottom = await store.createBottomTerminal("dir-1");
    expect(store.arrangementByScope["dir-1"]).toBeUndefined();
    expect(store.sessionsList("all").map((r) => r.tab.id)).not.toContain(bottom!.id);
    expect(store.centerSessions("dir-1")).toEqual([]);
  });

  it("closeBottomPane kills the pane and removes the tab when it was the last one", async () => {
    const store = await withDir();
    const tab = await store.createBottomTerminal("dir-1");

    await store.closeBottomPane(tab!.id);

    expect(tabsClosedIds).toContain(tab!.id);
    expect(store.bottomPanelFor("dir-1")).toBeNull();
    expect(store.arrangementByScope[bottomSurfaceKey("dir-1", "bt-1")]).toBeUndefined();
  });

  it("closeBottomPane keeps the tab alive while another pane remains", async () => {
    const store = await withDir();
    const first = await store.createBottomTerminal("dir-1");
    await store.splitSessionWithNew(first!.id, "h");
    const bottomTabId = store.bottomPanelFor("dir-1")!.tabs[0];
    const key = bottomSurfaceKey("dir-1", bottomTabId);
    const other = collectPaneIds(store.arrangementByScope[key].layout).find((id) => id !== first!.id)!;

    await store.closeBottomPane(other);

    expect(collectPaneIds(store.arrangementByScope[key].layout)).toEqual([first!.id]);
    expect(store.bottomPanelFor("dir-1")!.tabs).toEqual([bottomTabId]);
  });

  it("closeBottomTab kills every pane in the tab", async () => {
    const store = await withDir();
    const first = await store.createBottomTerminal("dir-1");
    await store.splitSessionWithNew(first!.id, "h");
    const bottomTabId = store.bottomPanelFor("dir-1")!.tabs[0];
    const panes = collectPaneIds(store.arrangementByScope[bottomSurfaceKey("dir-1", bottomTabId)].layout);

    await store.closeBottomTab("dir-1", bottomTabId);

    for (const id of panes) expect(tabsClosedIds).toContain(id);
    expect(store.bottomPanelFor("dir-1")).toBeNull();
  });

  it("closing the last center session does not adopt a bottom terminal", async () => {
    const store = await withDir();
    const center = await store.newSession("dir-1");
    const bottom = await store.createBottomTerminal("dir-1");

    await store.closeSession(center.id);

    expect(store.arrangementByScope["dir-1"]).toBeUndefined();
    const bottomKey = bottomSurfaceKey("dir-1", store.bottomPanelFor("dir-1")!.tabs[0]);
    expect(collectPaneIds(store.arrangementByScope[bottomKey].layout)).toEqual([bottom!.id]);
    expect(store.pendingPicker).toEqual({ dirId: "dir-1" });
  });

  it("persists collapsed + height per scope", async () => {
    const store = await withDir();
    await store.createBottomTerminal("dir-1");

    store.setBottomPanelCollapsed("dir-1", true);
    store.setBottomPanelHeight("dir-1", 10);

    expect(store.bottomPanelFor("dir-1")).toMatchObject({ collapsed: true, height: 120 });
    const write = setAppStateCalls.filter((c) => c.key === "bottom_panel_by_scope").at(-1);
    expect(JSON.parse(write!.value!)["dir-1"]).toMatchObject({ collapsed: true, height: 120 });
  });

  it("selectSession on a bottom terminal activates its tab instead of the center", async () => {
    const store = await withDir();
    const bottom = await store.createBottomTerminal("dir-1");
    store.setBottomPanelCollapsed("dir-1", true);

    store.selectSession(bottom!.id);

    expect(store.arrangementByScope["dir-1"]).toBeUndefined();
    expect(store.bottomPanelFor("dir-1")!.collapsed).toBe(false);
    expect(store.activeSurface).toBe("bottom");
  });

  it("splittableSessions lists only same-surface-class candidates", async () => {
    const store = await withDir();
    const center = await store.newSession("dir-1");
    const bottomA = await store.createBottomTerminal("dir-1");
    const bottomB = await store.createBottomTerminal("dir-1");
    const keyA = bottomSurfaceKey("dir-1", store.bottomPanelFor("dir-1")!.tabs[0]);

    const fromBottom = store.splittableSessions(keyA).map((r) => r.tab.id);
    const fromCenter = store.splittableSessions("dir-1").map((r) => r.tab.id);

    expect(fromBottom).toEqual([bottomB!.id]);
    expect(fromBottom).not.toContain(center.id);
    expect(fromCenter).not.toContain(bottomA!.id);
  });
});
