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

let nextId = 0;
function freshId(prefix: string) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

const setAppStateCalls: Array<{ key: string; value: string | null }> = [];
const tabsClosedIds: string[] = [];
const tabsSessionIdCalls: string[] = [];
const tabsCreateCalls: Array<{ directoryId: string }> = [];
const {
  getLiveTabIds,
  setLiveTabIds,
  setLiveTabIdsDeferred,
  resolveLiveTabIdsDeferred,
  queueLiveTabIdsDeferred,
  getTabsCreateDeferred,
  queueTabsCreateDeferred,
  appState,
  setFailArrangementGets,
  takeArrangementGetFailure,
  tabsListByDir,
} = vi.hoisted(() => {
  let liveTabIds: string[] = [];
  let deferred: { promise: Promise<string[]>; resolve: (ids: string[]) => void } | null = null;
  const queue: Array<{ promise: Promise<string[]>; resolve: (ids: string[]) => void }> = [];
  const tabsCreateQueue: Array<{ promise: Promise<void>; resolve: () => void }> = [];
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
  let failArrangementGets = 0;
  return {
    appState,
    tabsListByDir,
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

vi.mock("@/composables/useLanguageClient", () => ({
  stopClient: vi.fn(),
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
      tabsList: vi.fn(async (p: { directoryId?: string }) =>
        p.directoryId ? tabsListByDir[p.directoryId] ?? [] : Object.values(tabsListByDir).flat(),
      ),
      getAgentStates: vi.fn(async () => []),
      deleteDirectory: vi.fn(async () => true),
      worktreeRemove: vi.fn(async () => true),
      tabsCreate: vi.fn(async (opts: { directoryId: string; label?: string; cwd?: string }) => {
        tabsCreateCalls.push({ directoryId: opts.directoryId });
        const deferred = getTabsCreateDeferred();
        if (deferred) await deferred.promise;
        return {
          id: freshId("tab"),
          directoryId: opts.directoryId,
          label: opts.label ?? "shell",
          cwd: opts.cwd ?? null,
        };
      }),
      tabsClose: vi.fn(async (p: { id: string }) => {
        tabsClosedIds.push(p.id);
        return true;
      }),
      tabsSessionId: vi.fn(async (p: { id: string }) => {
        tabsSessionIdCalls.push(p.id);
        return null;
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

  it("closeSession on the last session in a directory spawns a fresh one when that directory is selected", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.newSession("dir-1");
    store.selectDirectory({ id: "dir-1", path: "/dir-1", name: "dir-1", createdAt: 0, sortOrder: 0 });
    setAppStateCalls.length = 0;

    await store.closeSession(tab1.id);

    // A replacement session was created for the now-empty, selected directory.
    expect(store.terminalTabsByDirectory["dir-1"]?.length).toBe(1);
    expect(store.terminalTabsByDirectory["dir-1"]?.[0].id).not.toBe(tab1.id);
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

describe("empty-scope auto-session (C2)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    tabsSessionIdCalls.length = 0;
    tabsCreateCalls.length = 0;
    nextId = 0;
    setLiveTabIds([]);
    appState.clear();
    for (const k of Object.keys(tabsListByDir)) delete tabsListByDir[k];
    setFailArrangementGets(0);
  });

  it("loadTabsForDirectory auto-creates a session for an empty selected directory", async () => {
    const store = useWorkspaceStore();
    store.selectDirectory(dir("dir-1"));
    await store.loadTabsForDirectory("dir-1");
    await vi.waitFor(() => {
      expect(store.terminalTabsByDirectory["dir-1"]?.length).toBe(1);
    });
    expect(parsedArrangement("dir-1")).toEqual({
      version: 1,
      layout: { pane: store.terminalTabsByDirectory["dir-1"][0].id },
    });
  });

  it("does not auto-create for a non-selected directory", async () => {
    const store = useWorkspaceStore();
    await store.loadTabsForDirectory("dir-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(store.terminalTabsByDirectory["dir-1"]).toEqual([]);
  });

  it("selectDirectory auto-creates when tabs are already loaded and empty", async () => {
    const store = useWorkspaceStore();
    await store.loadTabsForDirectory("dir-1"); // not selected → stays empty
    store.selectDirectory(dir("dir-1"));
    await vi.waitFor(() => {
      expect(store.terminalTabsByDirectory["dir-1"]?.length).toBe(1);
    });
  });

  it("concurrent loads create exactly one session (in-flight de-dupe)", async () => {
    const store = useWorkspaceStore();
    store.selectDirectory(dir("dir-1"));
    await Promise.all([
      store.loadTabsForDirectory("dir-1"),
      store.loadTabsForDirectory("dir-1"),
    ]);
    await vi.waitFor(() => {
      expect(store.terminalTabsByDirectory["dir-1"]?.length).toBe(1);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.terminalTabsByDirectory["dir-1"]?.length).toBe(1);
  });

  it("concurrent selectDirectory + load-tail auto-create produce exactly one tabsCreate call", async () => {
    const store = useWorkspaceStore();
    // Populate the bucket as empty first (not selected), so selectDirectory's
    // guard can fire directly (mirrors "tabs already loaded and empty" above).
    await store.loadTabsForDirectory("dir-1");
    expect(tabsCreateCalls.length).toBe(0);

    const deferred = queueTabsCreateDeferred();
    // selectDirectory fires the guard synchronously -> newSession -> tabsCreate
    // (pending on `deferred`). Before it resolves, a second load's
    // ensureLayoutModel2 tail re-checks the still-empty bucket and would fire
    // its own auto-create if it weren't single-flighted with the first.
    store.selectDirectory(dir("dir-1"));
    await store.loadTabsForDirectory("dir-1");
    deferred.resolve();

    await vi.waitFor(() => {
      expect(store.terminalTabsByDirectory["dir-1"]?.length).toBe(1);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(tabsCreateCalls.length).toBe(1);
    expect(store.terminalTabsByDirectory["dir-1"]?.length).toBe(1);
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
