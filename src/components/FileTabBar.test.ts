// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App, type Component } from "vue";
import type { FilePanelTab } from "@/types";

const dnd = vi.hoisted(() => ({
  dragEnd: null as null | ((event: unknown) => void),
}));

vi.mock("@dnd-kit/vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    DragDropProvider: defineComponent({
      inheritAttrs: false,
      setup(_, { attrs, slots }) {
        return () => {
          dnd.dragEnd = attrs.onDragEnd as typeof dnd.dragEnd;
          return h("div", { "data-drag-provider": "" }, slots.default?.());
        };
      },
    }),
  };
});

vi.mock("./dnd/SortableItem.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { id: String, index: Number, group: String },
      setup(props, { slots }) {
        return () => h("div", {
          "data-sortable-id": props.id,
          "data-sortable-index": props.index,
          "data-sortable-group": props.group,
        }, slots.default?.());
      },
    }),
  };
});
vi.mock("@/components/dnd/sensors", () => ({ sortableSensors: [] }));

vi.mock("./ui/context-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const wrapper = (tag: string) => defineComponent({
    setup(_, { slots }) { return () => h(tag, slots.default?.()); },
  });
  return {
    ContextMenu: wrapper("div"),
    ContextMenuContent: wrapper("div"),
    ContextMenuSeparator: wrapper("hr"),
    ContextMenuTrigger: wrapper("div"),
    ContextMenuItem: defineComponent({
      emits: ["select"],
      setup(_, { emit, slots }) {
        return () => h("button", {
          "data-context-item": "",
          onClick: () => emit("select"),
        }, slots.default?.());
      },
    }),
  };
});

vi.mock("./ui/dropdown-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const wrapper = (tag: string) => defineComponent({
    setup(_, { slots }) { return () => h(tag, slots.default?.()); },
  });
  return {
    DropdownMenu: wrapper("div"),
    DropdownMenuContent: wrapper("div"),
    DropdownMenuShortcut: wrapper("kbd"),
    DropdownMenuTrigger: wrapper("div"),
    DropdownMenuItem: defineComponent({
      emits: ["select"],
      setup(_, { emit, slots }) {
        return () => h("button", {
          "data-dropdown-item": "",
          onClick: () => emit("select"),
        }, slots.default?.());
      },
    }),
  };
});

vi.mock("./ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const wrapper = defineComponent({
    setup(_, { slots }) { return () => h("div", slots.default?.()); },
  });
  return {
    Tooltip: wrapper,
    TooltipContent: wrapper,
    TooltipProvider: wrapper,
    TooltipTrigger: wrapper,
  };
});

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({ request: { revealInFinder: vi.fn() } }),
}));
vi.mock("@/composables/useAddToAgent", () => ({ addToAgent: vi.fn() }));
vi.mock("vue-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const tabs: FilePanelTab[] = [
  { kind: "sourceControl", id: "__sc__" },
  { kind: "browser", id: "browser:1", label: "Example", browserUrl: "https://example.com" },
  { kind: "commits", id: "__commits__" },
  { kind: "file", id: "/repo/a.ts", filePath: "/repo/a.ts", label: "a.ts" },
  { kind: "search", id: "__search__" },
  { kind: "explorer", id: "explorer:1" },
  { kind: "notes", id: "__notes__" },
];

async function loadTabBar(): Promise<Component> {
  return (await import("./FileTabBar.vue")).default;
}

async function mountTabBar() {
  const tabBar = await loadTabBar();
  const host = document.createElement("div");
  const events = {
    close: vi.fn(),
    openKind: vi.fn(),
    reorder: vi.fn(),
  };
  document.body.append(host);
  const app = createApp({
    render: () => h(tabBar, {
      tabs,
      activeId: "browser:1",
      isFileDirty: (path: string) => path.endsWith("a.ts"),
      rootDir: "/repo",
      onClose: events.close,
      onOpenKind: events.openKind,
      onReorder: events.reorder,
    }),
  });
  app.mount(host);
  await nextTick();
  return { app, events, host };
}

describe("FileTabBar", () => {
  let app: App | null = null;

  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    dnd.dragEnd = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("renders every tab in one sortable strip with one leading visual", async () => {
    const mounted = await mountTabBar();
    app = mounted.app;
    const sortable = Array.from(mounted.host.querySelectorAll<HTMLElement>("[data-sortable-id]"));

    expect(sortable.map((item) => item.dataset.sortableId)).toEqual(tabs.map((tab) => tab.id));
    expect(sortable.map((item) => item.dataset.sortableIndex)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(new Set(sortable.map((item) => item.dataset.sortableGroup))).toEqual(new Set(["right-panel-tabs"]));
    expect(sortable.map((item) => item.querySelector<HTMLButtonElement>("button[data-tab-id]")?.textContent?.trim())).toEqual([
      "Source Control", "Example", "History", "a.ts", "Search", "Files", "Notes",
    ]);

    for (const item of sortable) {
      const trigger = item.querySelector<HTMLButtonElement>("button[data-tab-id]");
      expect(trigger).not.toBeNull();
      const leading = Array.from(trigger?.children ?? []).filter((child) =>
        child.matches("svg, img"),
      );
      expect(leading).toHaveLength(1);
    }
  });

  it("reorders every tab kind in the shared index space", async () => {
    const mounted = await mountTabBar();
    app = mounted.app;

    dnd.dragEnd?.({
      canceled: false,
      operation: { source: { id: "browser:1", initialIndex: 1, index: 5 } },
    });

    expect(mounted.events.reorder).toHaveBeenCalledWith([
      "__sc__", "__commits__", "/repo/a.ts", "__search__", "explorer:1", "browser:1", "__notes__",
    ]);
  });

  it("routes the trailing menu and scopes file-only context actions", async () => {
    const mounted = await mountTabBar();
    app = mounted.app;

    const openButton = mounted.host.querySelector<HTMLButtonElement>('button[title="Open Tab"]');
    expect(openButton).not.toBeNull();
    const browserEntry = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>("[data-dropdown-item]"))
      .find((item) => item.textContent?.includes("Browser"));
    browserEntry?.click();
    expect(mounted.events.openKind).toHaveBeenCalledWith("browser");

    const file = mounted.host.querySelector<HTMLElement>('[data-sortable-id="/repo/a.ts"]');
    const sourceControl = mounted.host.querySelector<HTMLElement>('[data-sortable-id="__sc__"]');
    expect(file?.textContent).toContain("Add to Agent");
    expect(file?.textContent).toContain("Copy Relative Path");
    expect(sourceControl?.textContent).not.toContain("Add to Agent");
    expect(sourceControl?.textContent).not.toContain("Copy Path");
    expect(sourceControl?.textContent).toContain("Close All");

    const closeAll = Array.from(sourceControl?.querySelectorAll<HTMLButtonElement>("[data-context-item]") ?? [])
      .find((item) => item.textContent?.trim() === "Close All");
    closeAll?.click();
    expect(mounted.events.close.mock.calls.map(([id]) => id)).toEqual(tabs.map((tab) => tab.id));
  });
});
