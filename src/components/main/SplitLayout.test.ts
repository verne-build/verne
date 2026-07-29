// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, onMounted } from "vue";

const store = vi.hoisted(() => ({
  setArrangementSizes: vi.fn(),
  setCenterDisplayArrangementSizes: vi.fn(),
  centerSplitPickerSource: vi.fn(() => "session-a"),
}));
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => store }));
vi.mock("@/composables/useTerminal", () => ({ setSplitterDragging: vi.fn() }));
vi.mock("./TerminalPane.vue", () => ({
  default: defineComponent({
    props: {
      paneId: { type: String, required: true },
      scopeId: { type: String, required: true },
      endMode: String,
      compact: Boolean,
      horizontalOnly: Boolean,
    },
    setup(props) {
      return () => h("div", {
        "data-terminal-pane": props.paneId,
        "data-scope-id": props.scopeId,
        "data-end-mode": props.endMode,
        "data-compact": String(props.compact),
        "data-horizontal-only": String(props.horizontalOnly),
      });
    },
  }),
}));
vi.mock("./CenterPaneAnchor.vue", () => ({
  default: defineComponent({
    props: { anchorId: { type: String, required: true } },
    setup(props) {
      return () => h("div", { "data-center-pane-anchor": props.anchorId });
    },
  }),
}));
vi.mock("./CenterSplitSessionPicker.vue", () => ({
  default: defineComponent({
    props: { pickerId: { type: String, required: true } },
    setup(props) {
      return () => h("div", { "data-center-picker": props.pickerId });
    },
  }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizableHandle: defineComponent(() => () => h("div")),
  ResizablePanel: defineComponent((_props, { slots }) => () => h("div", slots.default?.())),
  ResizablePanelGroup: defineComponent({
    emits: ["layout"],
    setup(_props, { emit, slots }) {
      onMounted(() => emit("layout", [30, 70]));
      return () => h("div", slots.default?.());
    },
  }),
}));

import SplitLayout from "./SplitLayout.vue";

describe("SplitLayout center display resizing", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.useFakeTimers();
    store.setArrangementSizes.mockReset();
    store.setCenterDisplayArrangementSizes.mockReset();
    store.setCenterDisplayArrangementSizes.mockReturnValue(true);
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    app?.unmount();
    host.remove();
    vi.useRealTimers();
  });

  it("commits transient center sizes synchronously so Start cannot beat a debounce", async () => {
    app = createApp({
      render: () => h(SplitLayout, {
        node: {
          direction: "h" as const,
          children: [{ pane: "session-a" }, { pane: "center-picker:test" }],
          sizes: [50, 50],
        },
        scopeId: "dir-1",
        multi: true,
        centerDisplay: true,
      }),
    });
    app.mount(host);
    await nextTick();

    expect(store.setCenterDisplayArrangementSizes).toHaveBeenCalledWith(
      "dir-1",
      "session-a|center-picker:test",
      [30, 70],
    );
    expect(store.setArrangementSizes).not.toHaveBeenCalled();
  });

  it("keeps ordinary center arrangement persistence debounced", async () => {
    store.setCenterDisplayArrangementSizes.mockReturnValue(false);
    app = createApp({
      render: () => h(SplitLayout, {
        node: {
          direction: "h" as const,
          children: [{ pane: "session-a" }, { pane: "session-b" }],
          sizes: [50, 50],
        },
        scopeId: "dir-1",
        multi: true,
        centerDisplay: true,
      }),
    });
    app.mount(host);
    await nextTick();

    expect(store.setArrangementSizes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);

    expect(store.setArrangementSizes).toHaveBeenCalledWith(
      "dir-1",
      "session-a|session-b",
      [30, 70],
    );
  });
});

describe("SplitLayout center pane anchors", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp>;

  function mount(props: InstanceType<typeof SplitLayout>["$props"]) {
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({ render: () => h(SplitLayout, props) });
    app.mount(host);
  }

  beforeEach(() => {
    host = document.createElement("div");
  });

  afterEach(() => {
    app?.unmount();
    host.remove();
  });

  it("anchors an opted-in real center session leaf", async () => {
    mount({
      node: { pane: "session-a" },
      scopeId: "dir-1",
      multi: false,
      centerDisplay: true,
      persistentCenterPanes: true,
    });
    await nextTick();

    expect(host.querySelector('[data-center-pane-anchor="center-pane:dir-1:session-a"]')).not.toBeNull();
    expect(host.querySelector('[data-terminal-pane="session-a"]')).toBeNull();
  });

  it("keeps center split pickers ahead of anchors", async () => {
    mount({
      node: { pane: "center-picker:test" },
      scopeId: "dir-1",
      multi: false,
      centerDisplay: true,
      persistentCenterPanes: true,
    });
    await nextTick();

    expect(host.querySelector('[data-center-picker="center-picker:test"]')).not.toBeNull();
    expect(host.querySelector("[data-center-pane-anchor]")).toBeNull();
  });

  it("keeps the embedded center terminal while the rollout is disabled", async () => {
    mount({
      node: { pane: "session-a" },
      scopeId: "dir-1",
      multi: false,
      centerDisplay: true,
      persistentCenterPanes: false,
    });
    await nextTick();

    expect(host.querySelector('[data-terminal-pane="session-a"]')).not.toBeNull();
    expect(host.querySelector("[data-center-pane-anchor]")).toBeNull();
  });

  it("keeps non-center close-mode terminals embedded with their pane props", async () => {
    mount({
      node: { pane: "session-a" },
      scopeId: "bottom:dir-1:bt-1",
      multi: false,
      centerDisplay: false,
      persistentCenterPanes: true,
      endMode: "close",
      compact: true,
      horizontalOnly: true,
    });
    await nextTick();

    const pane = host.querySelector('[data-terminal-pane="session-a"]');
    expect(pane).not.toBeNull();
    expect(pane?.getAttribute("data-scope-id")).toBe("bottom:dir-1:bt-1");
    expect(pane?.getAttribute("data-end-mode")).toBe("close");
    expect(pane?.getAttribute("data-compact")).toBe("true");
    expect(pane?.getAttribute("data-horizontal-only")).toBe("true");
    expect(host.querySelector("[data-center-pane-anchor]")).toBeNull();
  });

  it("forwards the opted-in anchor branch through nested horizontal and vertical splits", async () => {
    mount({
      node: {
        direction: "h",
        children: [
          { pane: "session-a" },
          {
            direction: "v",
            children: [{ pane: "session-b" }, { pane: "session-c" }],
            sizes: [50, 50],
          },
        ],
        sizes: [50, 50],
      },
      scopeId: "dir-1",
      multi: true,
      centerDisplay: true,
      persistentCenterPanes: true,
    });
    await nextTick();

    for (const paneId of ["session-a", "session-b", "session-c"]) {
      expect(host.querySelectorAll(`[data-center-pane-anchor="center-pane:dir-1:${paneId}"]`)).toHaveLength(1);
    }
    expect(host.querySelector("[data-terminal-pane]")).toBeNull();
  });
});
