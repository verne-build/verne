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
      tabsCreate: vi.fn(async (opts: { label?: string }) => ({
        id: freshId("tab"),
        directoryId: "dir-1",
        label: opts.label ?? "shell",
        cwd: null,
      })),
      groupCreate: vi.fn(async (p: { directoryId: string; layout: string; activePaneId?: string | null }) => ({
        id: freshId("group"),
        directoryId: p.directoryId,
        sortOrder: 0,
        activePaneId: p.activePaneId,
        layout: p.layout,
      })),
      groupUpdateLayout: vi.fn(async () => true),
      groupSetActivePane: vi.fn(async () => true),
      groupDelete: vi.fn(async () => true),
      groupsReorder: vi.fn(async () => true),
      tabsClose: vi.fn(async () => true),
      tabsSessionId: vi.fn(async () => null),
    },
  }),
}));

import { useWorkspaceStore } from "./workspace";
import { nodeKey } from "@/lib/paneLayout";

function lastArrangementWrite() {
  const writes = setAppStateCalls.filter((c) => c.key === "arrangement_by_scope");
  return writes.at(-1);
}

describe("workspace store arrangement dual-write", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setAppStateCalls.length = 0;
    nextId = 0;
  });

  it("dual-writes on createTab", async () => {
    const store = useWorkspaceStore();
    await store.createTab({ directoryId: "dir-1" });
    const write = lastArrangementWrite();
    expect(write).toBeTruthy();
    const parsed = JSON.parse(write!.value!);
    expect(parsed["dir-1"]).toBeTruthy();
  });

  it("dual-writes on splitPane", async () => {
    const store = useWorkspaceStore();
    const tab = await store.createTab({ directoryId: "dir-1" });
    setAppStateCalls.length = 0;
    await store.splitPane(tab!.id, "h");
    const write = lastArrangementWrite();
    expect(write).toBeTruthy();
  });

  it("dual-writes on movePane (regression)", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.createTab({ directoryId: "dir-1" });
    const tab2 = await store.splitPane(tab1!.id, "h");
    setAppStateCalls.length = 0;

    await store.movePane(tab2!.id, tab1!.id, "v", true);

    const write = lastArrangementWrite();
    expect(write).toBeTruthy();

    const parsed = JSON.parse(write!.value!);
    const arr = parsed["dir-1"];
    expect(arr).toBeTruthy();
    // The active group's layout after the move must be reflected in the
    // dual-written arrangement.
    expect(JSON.stringify(arr.layout ?? arr)).toContain(tab2!.id);
  });

  it("dual-writes on updateGroupSizes", async () => {
    const store = useWorkspaceStore();
    const tab1 = await store.createTab({ directoryId: "dir-1" });
    await store.splitPane(tab1!.id, "h");
    const group = store.tabGroupsByDirectory["dir-1"][0];
    setAppStateCalls.length = 0;

    store.updateGroupSizes(group.id, nodeKey(group.layout), [40, 60]);

    const write = lastArrangementWrite();
    expect(write).toBeTruthy();
  });
});
