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
const {
  getLiveTabIds,
  setLiveTabIds,
  setLiveTabIdsDeferred,
  resolveLiveTabIdsDeferred,
  queueLiveTabIdsDeferred,
} = vi.hoisted(() => {
  let liveTabIds: string[] = [];
  let deferred: { promise: Promise<string[]>; resolve: (ids: string[]) => void } | null = null;
  const queue: Array<{ promise: Promise<string[]>; resolve: (ids: string[]) => void }> = [];
  function makeDeferred() {
    let resolve!: (ids: string[]) => void;
    const promise = new Promise<string[]>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  return {
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
  };
});

vi.mock("@/composables/useLanguageClient", () => ({
  stopClient: vi.fn(),
}));

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      getAppState: vi.fn(async () => null),
      setAppState: vi.fn(async (p: { key: string; value: string | null }) => {
        setAppStateCalls.push(p);
        return true;
      }),
      groupsList: vi.fn(async () => []),
      tabsCreate: vi.fn(async (opts: { directoryId: string; label?: string; cwd?: string }) => ({
        id: freshId("tab"),
        directoryId: opts.directoryId,
        label: opts.label ?? "shell",
        cwd: opts.cwd ?? null,
      })),
      tabsClose: vi.fn(async (p: { id: string }) => {
        tabsClosedIds.push(p.id);
        return true;
      }),
      tabsSessionId: vi.fn(async () => null),
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
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    nextId = 0;
    setLiveTabIds([]);
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
});

describe("workspace store session lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    tabsClosedIds.length = 0;
    nextId = 0;
    setLiveTabIds([]);
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
