// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  type Ref,
} from "vue";
import type { LayoutNode } from "@/types";

const testState = vi.hoisted(() => ({
  store: null as any,
  tabsSessionId: vi.fn(),
  tabsResume: vi.fn(),
  incrementMountedTerminalViewCount: vi.fn(),
  decrementMountedTerminalViewCount: vi.fn(),
}));

const terminalLifecycle = {
  mountOrder: [] as string[],
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
};

vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => testState.store }));
vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      tabsSessionId: (...args: unknown[]) => testState.tabsSessionId(...args),
      tabsResume: (...args: unknown[]) => testState.tabsResume(...args),
      tabsHasRunningChild: vi.fn(async () => false),
    },
  }),
}));
vi.mock("@/composables/useTerminal", () => ({
  setSplitterDragging: vi.fn(),
  incrementMountedTerminalViewCount: () => testState.incrementMountedTerminalViewCount(),
  decrementMountedTerminalViewCount: () => testState.decrementMountedTerminalViewCount(),
}));
vi.mock("@/composables/useShortcuts", () => ({
  useShortcuts: () => ({ displayKeys: () => [] }),
}));
vi.mock("@/composables/useAgentIcon", () => ({
  agentIconSurfaceForTheme: () => "light",
  getAgentIconForSurface: () => null,
}));
vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({
    activeThemeName: ref("test"),
    getActiveThemeSpec: () => ({ type: "dark" }),
  }),
}));
vi.mock("@/platform", () => ({ ask: vi.fn(async () => true) }));
vi.mock("./NewSessionPicker.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { dirId: { type: String, required: true } },
      setup: (props) => () => h("div", { "data-new-session-picker": props.dirId }),
    }),
  };
});
vi.mock("./WelcomeHero.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent(() => () => h("div", { "data-welcome-hero": "" })) };
});
vi.mock("./CenterSplitSessionPicker.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { pickerId: { type: String, required: true } },
      setup: (props) => () => h("div", { "data-center-split-picker": props.pickerId }),
    }),
  };
});
vi.mock("@/components/ui/resizable", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    ResizableHandle: defineComponent((_props, { slots }) => () => h("div", slots.default?.())),
    ResizablePanel: defineComponent((_props, { slots }) => () => h("div", slots.default?.())),
    ResizablePanelGroup: defineComponent((_props, { slots }) => () => h("div", slots.default?.())),
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const wrapper = defineComponent((_props, { slots }) => () => h("div", slots.default?.()));
  return {
    TooltipProvider: wrapper,
    Tooltip: wrapper,
    TooltipTrigger: defineComponent({
      props: { asChild: Boolean },
      setup: (_props, { slots }) => () => h("div", slots.default?.()),
    }),
    TooltipContent: wrapper,
  };
});

interface Arrangement {
  layout: LayoutNode;
}

interface PendingPicker {
  dirId: string;
}

function createStore() {
  const centerDisplayArrangements = reactive<Record<string, Arrangement | null>>({
    "dir-1": { layout: { pane: "session-a" } },
    "dir-2": { layout: { pane: "session-c" } },
  });
  return reactive({
    selectedDirectoryId: "dir-1" as string | undefined,
    pendingPicker: null as PendingPicker | null,
    directories: [
      { id: "dir-1", name: "Repo One", path: "/repo-one" },
      { id: "dir-2", name: "Repo Two", path: "/repo-two" },
    ],
    directoriesLoaded: true,
    welcomeSeen: true,
    focusedSessionId: "session-a" as string | undefined,
    activeSurface: "center",
    bottomFocusedSessionId: undefined as string | undefined,
    centerDisplayArrangements,
    centerDisplayArrangementFor: vi.fn((dirId: string) => centerDisplayArrangements[dirId] ?? null),
    arrangementFor: vi.fn((dirId: string) => centerDisplayArrangements[dirId] ?? null),
    bottomPanelFor: vi.fn(() => null),
    sessionsList: vi.fn(() => []),
    closeSession: vi.fn(async () => {}),
    removeFromView: vi.fn(),
    archiveSession: vi.fn(async () => {}),
    setCenterDisplayArrangementSizes: vi.fn(() => true),
    setArrangementSizes: vi.fn(),
    centerSplitPickerSource: vi.fn(() => "session-a"),
    terminalTabsByDirectory: {
      "dir-1": [{
        id: "session-a",
        directoryId: "dir-1",
        label: "A",
        cwd: "/repo-one",
        archivedAt: null as string | null,
        resumeAvailable: false,
      }],
      "dir-2": [{
        id: "session-c",
        directoryId: "dir-2",
        label: "C",
        cwd: "/repo-two",
        archivedAt: null as string | null,
        resumeAvailable: false,
      }],
    },
    tabRuntime: new Map<string, { agentState?: string; agentType?: string }>(),
    sessionLifecycle: new Map<string, string>(),
    focusedByScope: {} as Record<string, string | undefined>,
    splittableSessions: vi.fn(() => []),
    sessionName: vi.fn((paneId: string) => paneId),
    focusSession: vi.fn(),
    syncViewportSize: vi.fn(),
    markSessionRunning: vi.fn(),
    unarchiveSession: vi.fn(async () => {}),
    openCenterSplitPicker: vi.fn(),
    splitSessionWithNew: vi.fn(),
    splitSessionWithExisting: vi.fn(),
    closeBottomPane: vi.fn(async () => {}),
  });
}

const TerminalPaneProbe = defineComponent({
  name: "TerminalPaneProbe",
  props: {
    paneId: { type: String, required: true },
    scopeId: { type: String, required: true },
    focusedSessionId: String,
    multi: { type: Boolean, required: true },
    reserveLeftOverlay: Boolean,
    reserveRightOverlay: Boolean,
  },
  setup(props) {
    const findText = ref("");
    onMounted(() => {
      terminalLifecycle.mountOrder.push(props.paneId);
      terminalLifecycle.mounts.set(
        props.paneId,
        (terminalLifecycle.mounts.get(props.paneId) ?? 0) + 1,
      );
    });
    onUnmounted(() => {
      terminalLifecycle.unmounts.set(
        props.paneId,
        (terminalLifecycle.unmounts.get(props.paneId) ?? 0) + 1,
      );
    });

    return () => h("section", {
      "data-terminal-pane-id": props.paneId,
      "data-scope-id": props.scopeId,
      "data-focused-session-id": props.focusedSessionId,
      "data-multi": String(props.multi),
      "data-reserve-left-overlay": String(props.reserveLeftOverlay),
      "data-reserve-right-overlay": String(props.reserveRightOverlay),
    }, [
      h("div", { "data-terminal-scroll": "" }, [
        h("canvas", { "data-terminal-canvas": "" }),
        h("input", { "data-terminal-input": "" }),
        h("input", {
          "data-terminal-find": "",
          value: findText.value,
          onInput: (event: Event) => {
            findText.value = (event.target as HTMLInputElement).value;
          },
        }),
      ]),
    ]);
  },
});

const GridTerminalProbe = defineComponent({
  props: {
    sessionId: String,
    archivedTabId: String,
  },
  setup: (props) => () => h("div", {
    "data-grid-session-id": props.sessionId,
    "data-grid-archived-id": props.archivedTabId,
  }),
});

let app: ReturnType<typeof createApp> | null = null;
let host: HTMLDivElement;
let leftCollapsed: Ref<boolean>;
let rightCollapsed: Ref<boolean>;

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountTabs(options: { realTerminal?: boolean } = {}) {
  vi.resetModules();
  localStorage.removeItem("verne:persistent-center-panes");

  if (options.realTerminal) {
    vi.doUnmock("./TerminalPane.vue");
    vi.doMock("@/components/terminal/GridTerminal.vue", () => ({ default: GridTerminalProbe }));
  } else {
    vi.doMock("./TerminalPane.vue", () => ({ default: TerminalPaneProbe }));
  }

  const { default: TabsCenter } = await import("./TabsCenter.vue");
  host = document.createElement("div");
  document.body.append(host);
  leftCollapsed = ref(false);
  rightCollapsed = ref(false);
  app = createApp({ render: () => h(TabsCenter) });
  app.provide("leftCollapsed", leftCollapsed);
  app.provide("rightCollapsed", rightCollapsed);
  app.mount(host);
  await flush();
}

function setLayout(dirId: string, layout: LayoutNode | null): void {
  testState.store.centerDisplayArrangements[dirId] = layout ? { layout } : null;
}

function pane(paneId: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[data-terminal-pane-id="${paneId}"]`);
  if (!element) throw new Error(`Missing pane ${paneId}`);
  return element;
}

function visiblePaneOrder(): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-terminal-pane-id]"))
    .map((element) => element.dataset.terminalPaneId!);
}

beforeEach(() => {
  testState.store = createStore();
  testState.tabsSessionId.mockReset().mockImplementation(async ({ id }: { id: string }) => `pty:${id}`);
  testState.tabsResume.mockReset().mockImplementation(async ({ id }: { id: string }) => `pty:${id}`);
  testState.incrementMountedTerminalViewCount.mockReset();
  testState.decrementMountedTerminalViewCount.mockReset();
  terminalLifecycle.mountOrder.length = 0;
  terminalLifecycle.mounts.clear();
  terminalLifecycle.unmounts.clear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.replaceChildren();
  localStorage.removeItem("verne:persistent-center-panes");
  vi.doUnmock("./TerminalPane.vue");
  vi.doUnmock("@/components/terminal/GridTerminal.vue");
  vi.resetModules();
});

describe("TabsCenter layout controls", () => {
  it("keeps layout controls unbordered", async () => {
    await mountTabs();

    expect(host.querySelector("[data-layout-controls-divider]")).toBeNull();
  });

  it("uses the persistent host and center anchor without a rollout key", async () => {
    await mountTabs();

    expect(pane("session-a")).not.toBeNull();
    expect(localStorage.getItem("verne:persistent-center-panes")).toBeNull();
    expect(host.querySelector("[data-persistent-center-pane-host]")).not.toBeNull();
    expect(host.querySelector("[data-center-pane-anchor]")).not.toBeNull();
  });
});

describe("TabsCenter persistent pane lifecycle", () => {
  it("retains component, DOM, focus, scroll, and find state through split picker open and cancel", async () => {
    await mountTabs();
    const root = pane("session-a");
    const canvas = root.querySelector("[data-terminal-canvas]");
    const input = root.querySelector<HTMLInputElement>("[data-terminal-input]")!;
    const scroll = root.querySelector<HTMLElement>("[data-terminal-scroll]")!;
    const find = root.querySelector<HTMLInputElement>("[data-terminal-find]")!;
    scroll.scrollTop = 137;
    find.value = "needle";
    find.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();

    setLayout("dir-1", {
      direction: "h",
      children: [{ pane: "session-a" }, { pane: "center-picker:test" }],
      sizes: [50, 50],
    });
    await flush();
    expect(pane("session-a")).toBe(root);
    expect(root.querySelector("[data-terminal-canvas]")).toBe(canvas);
    expect(root.querySelector("[data-terminal-input]")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(scroll.scrollTop).toBe(137);
    expect(find.value).toBe("needle");

    setLayout("dir-1", { pane: "session-a" });
    await flush();
    expect(pane("session-a")).toBe(root);
    expect(root.querySelector("[data-terminal-canvas]")).toBe(canvas);
    expect(root.querySelector("[data-terminal-input]")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(scroll.scrollTop).toBe(137);
    expect(find.value).toBe("needle");
    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-a")).toBeUndefined();
  });

  it("mounts only the added split and unmounts only the removed pane", async () => {
    await mountTabs();
    const rootA = pane("session-a");

    setLayout("dir-1", {
      direction: "h",
      children: [{ pane: "session-a" }, { pane: "session-b" }],
      sizes: [50, 50],
    });
    await flush();
    const rootB = pane("session-b");

    expect(pane("session-a")).toBe(rootA);
    expect(terminalLifecycle.mounts).toEqual(new Map([
      ["session-a", 1],
      ["session-b", 1],
    ]));

    setLayout("dir-1", { pane: "session-b" });
    await flush();

    expect(pane("session-b")).toBe(rootB);
    expect(terminalLifecycle.unmounts).toEqual(new Map([["session-a", 1]]));
    expect(terminalLifecycle.mounts.get("session-b")).toBe(1);
  });

  it("preserves retained panes and follows depth-first DOM order across rearrangements", async () => {
    setLayout("dir-1", {
      direction: "h",
      children: [{ pane: "session-a" }, { pane: "session-b" }, { pane: "session-c" }],
      sizes: [34, 33, 33],
    });
    await mountTabs();
    const roots = new Map(["session-a", "session-b", "session-c"].map((id) => [id, pane(id)]));
    expect(visiblePaneOrder()).toEqual(["session-a", "session-b", "session-c"]);

    setLayout("dir-1", {
      direction: "v",
      children: [
        { pane: "session-c" },
        {
          direction: "h",
          children: [{ pane: "session-b" }, { pane: "session-a" }],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    });
    await flush();

    expect(visiblePaneOrder()).toEqual(["session-c", "session-b", "session-a"]);
    for (const [id, root] of roots) {
      expect(pane(id)).toBe(root);
      expect(terminalLifecycle.mounts.get(id)).toBe(1);
      expect(terminalLifecycle.unmounts.get(id)).toBeUndefined();
    }
  });

  it("updates focus and overlay props without remounting", async () => {
    await mountTabs();
    const root = pane("session-a");

    testState.store.focusedSessionId = "session-b";
    leftCollapsed.value = true;
    rightCollapsed.value = true;
    await flush();

    expect(pane("session-a")).toBe(root);
    expect(root.dataset.focusedSessionId).toBe("session-b");
    expect(root.dataset.reserveLeftOverlay).toBe("true");
    expect(root.dataset.reserveRightOverlay).toBe("true");
    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-a")).toBeUndefined();
  });

  it("switches to the full-page picker and unmounts every hosted pane", async () => {
    await mountTabs();

    testState.store.pendingPicker = { dirId: "dir-1" };
    await flush();

    expect(host.querySelector('[data-new-session-picker="dir-1"]')).not.toBeNull();
    expect(host.querySelector("[data-persistent-center-pane-host]")).toBeNull();
    expect(terminalLifecycle.unmounts).toEqual(new Map([["session-a", 1]]));
  });

  it("destroys the old directory panes before mounting the new directory panes", async () => {
    await mountTabs();

    testState.store.selectedDirectoryId = "dir-2";
    testState.store.focusedSessionId = "session-c";
    await flush();

    expect(host.querySelector('[data-terminal-pane-id="session-a"]')).toBeNull();
    expect(pane("session-c").dataset.scopeId).toBe("dir-2");
    expect(terminalLifecycle.unmounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.mounts.get("session-c")).toBe(1);
  });

  it("unmounts every hosted pane and renders the hydration fallback without an arrangement", async () => {
    await mountTabs();

    setLayout("dir-1", null);
    await flush();

    expect(host.querySelector("[data-persistent-center-pane-host]")).toBeNull();
    expect(host.querySelector("[data-terminal-pane-id]")).toBeNull();
    expect(host.querySelector("[data-new-session-picker]")).toBeNull();
    expect(terminalLifecycle.unmounts).toEqual(new Map([["session-a", 1]]));
  });

  it("keeps one pane instance through one hundred split picker open/cancel cycles", async () => {
    await mountTabs();
    const root = pane("session-a");

    for (let index = 0; index < 100; index += 1) {
      setLayout("dir-1", {
        direction: index % 2 === 0 ? "h" : "v",
        children: [{ pane: "session-a" }, { pane: `center-picker:${index}` }],
        sizes: [50, 50],
      });
      await flush();
      setLayout("dir-1", { pane: "session-a" });
      await flush();
    }

    expect(pane("session-a")).toBe(root);
    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-a")).toBeUndefined();
  });
});

describe("TabsCenter real TerminalPane lifecycle", () => {
  it("does not reacquire or recount a retained terminal across picker split and cancel", async () => {
    await mountTabs({ realTerminal: true });
    const root = pane("session-a");

    setLayout("dir-1", {
      direction: "h",
      children: [{ pane: "session-a" }, { pane: "center-picker:test" }],
      sizes: [50, 50],
    });
    await flush();
    setLayout("dir-1", { pane: "session-a" });
    await flush();

    expect(pane("session-a")).toBe(root);
    expect(testState.tabsSessionId).toHaveBeenCalledTimes(1);
    expect(testState.incrementMountedTerminalViewCount).toHaveBeenCalledTimes(1);
    expect(testState.decrementMountedTerminalViewCount).not.toHaveBeenCalled();

    setLayout("dir-1", null);
    await flush();
    expect(testState.decrementMountedTerminalViewCount).toHaveBeenCalledTimes(1);
  });

  it("keeps an archived pane instance and never resolves a live session while archived", async () => {
    testState.store.terminalTabsByDirectory["dir-1"][0].archivedAt = "2026-07-28T12:00:00Z";
    await mountTabs({ realTerminal: true });
    const root = pane("session-a");

    expect(host.querySelector('[data-grid-archived-id="session-a"]')).not.toBeNull();
    expect(testState.tabsSessionId).not.toHaveBeenCalled();

    testState.store.terminalTabsByDirectory["dir-1"][0].archivedAt = null;
    await flush();

    expect(pane("session-a")).toBe(root);
    expect(testState.tabsSessionId).toHaveBeenCalledTimes(1);
    expect(testState.incrementMountedTerminalViewCount).toHaveBeenCalledTimes(1);
    expect(testState.decrementMountedTerminalViewCount).not.toHaveBeenCalled();
  });

  it("keeps the live grid and exit overlay through picker split and cancel", async () => {
    await mountTabs({ realTerminal: true });
    const root = pane("session-a");
    const grid = root.querySelector('[data-grid-session-id="pty:session-a"]');

    expect(grid).not.toBeNull();
    expect(testState.tabsSessionId).toHaveBeenCalledTimes(1);

    testState.store.sessionLifecycle.set("session-a", "exited");
    await flush();
    const exitOverlay = Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Session exited"));
    expect(exitOverlay).not.toBeUndefined();
    expect(root.querySelector('[data-grid-session-id="pty:session-a"]')).toBe(grid);

    setLayout("dir-1", {
      direction: "h",
      children: [{ pane: "session-a" }, { pane: "center-picker:test" }],
      sizes: [50, 50],
    });
    await flush();
    setLayout("dir-1", { pane: "session-a" });
    await flush();

    expect(pane("session-a")).toBe(root);
    expect(root.querySelector('[data-grid-session-id="pty:session-a"]')).toBe(grid);
    expect(Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Session exited"))).toBe(exitOverlay);
    expect(exitOverlay?.isConnected).toBe(true);
    expect(root.contains(exitOverlay!)).toBe(true);
    expect(testState.tabsSessionId).toHaveBeenCalledTimes(1);

    testState.store.sessionLifecycle.set("session-a", "running");
    await flush();

    expect(pane("session-a")).toBe(root);
    expect(root.querySelector('[data-grid-session-id="pty:session-a"]')).toBe(grid);
    expect(root.textContent).not.toContain("Session exited");
    expect(testState.tabsSessionId).toHaveBeenCalledTimes(1);
    expect(testState.incrementMountedTerminalViewCount).toHaveBeenCalledTimes(1);
    expect(testState.decrementMountedTerminalViewCount).not.toHaveBeenCalled();
  });
});
