// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App, type Component } from "vue";

const panel = vi.hoisted(() => ({ api: null as any }));
const rpc = vi.hoisted(() => ({
  getAppState: vi.fn().mockResolvedValue(null),
  gitDiff: vi.fn().mockResolvedValue({ original: "old", modified: "new" }),
  gitCommitFileDiff: vi.fn().mockResolvedValue({ original: "old", modified: "new" }),
  shadowRemove: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => ({
    activeRoot: { path: "/repo", scopeType: "directory", scopeId: "dir-1" },
  }),
}));

vi.mock("@/composables/useFilePanelTabs", async () => {
  const { computed, ref } = await import("vue");
  const tabs = ref<any[]>([{ kind: "sourceControl", id: "__sc__" }]);
  const activeId = ref<string | null>("__sc__");
  const api = {
    tabs,
    activeId,
    activeTab: computed(() => tabs.value.find((tab) => tab.id === activeId.value) ?? null),
    setActiveId: vi.fn((id: string) => { activeId.value = id; }),
    closeTab: vi.fn(),
    reorderTabs: vi.fn(),
    setFileDirty: vi.fn(),
    isFileDirty: vi.fn(() => false),
    updateTabViewState: vi.fn(),
    openTabOfKind: vi.fn(),
    openFile: vi.fn(),
    openBrowserTab: vi.fn(),
    promoteTab: vi.fn(),
    focusMostRecentFileOrExplorer: vi.fn(() => null),
    scSelection: ref(null),
    commitsSelection: ref(null),
    setScSelection: vi.fn(),
    setCommitsSelection: vi.fn(),
  };
  panel.api = api;
  return { useFilePanelTabs: () => api };
});

vi.mock("@/composables/useRpc", () => ({ useRpc: () => ({ request: rpc }) }));
vi.mock("@/platform", () => ({ ask: vi.fn().mockResolvedValue(true) }));
vi.mock("@/composables/useDiffReview", () => ({
  useDiffReview: () => ({
    loadScope: vi.fn(),
    scopeSummary: () => ({ total: 0, files: 0 }),
    fileCommentCounts: () => ({}),
  }),
}));
vi.mock("@/composables/useSearchPanelState", async () => {
  const { ref } = await import("vue");
  return { useSearchPanelState: () => ({ selected: ref(null) }) };
});
vi.mock("@/composables/useGitOperations", async () => {
  const { ref } = await import("vue");
  return {
    useGitOperations: () => ({
      gitStatus: ref(null), gitBusy: ref(false), canPublish: ref(false), canSyncUpstream: ref(false),
      pull: vi.fn(), push: vi.fn(), publish: vi.fn(),
    }),
  };
});
vi.mock("@/composables/usePanelResizeState", async () => {
  const { ref } = await import("vue");
  return {
    usePanelResizeState: () => ({
      open: ref(false), dismissOverlay: vi.fn(), applyPersisted: vi.fn(), dispose: vi.fn(),
    }),
  };
});
vi.mock("@/lib/overlaySidebar", () => ({ judgedWidth: (width: number) => width }));
vi.mock("@/lib/panelAnimationState", async () => {
  const { ref } = await import("vue");
  return { panelsAnimating: ref(false) };
});
vi.mock("@/lib/bootstrapCache", () => ({
  readCachedPanelState: () => ({}),
  writeCachedFileExplorerVisible: vi.fn(),
}));
vi.mock("@/lib/scSelectionReconcile", () => ({ scSelectionStillChanged: () => true }));
vi.mock("vue-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("./SourceControlTab.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      emits: ["switchView", "jump"],
      setup(_, { emit }) {
        return () => h("div", [
          h("button", { "data-switch-history": "", onClick: () => emit("switchView", "history") }),
          h("button", {
            "data-jump-source": "",
            onClick: () => emit("jump", { source: "sourceControl", relPath: "src/a.ts", staged: false }),
          }),
        ]);
      },
    }),
  };
});

vi.mock("./CommitsTab.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
});

vi.mock("./FileTabBar.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./RightPanelPicker.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./SearchPreview.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./SearchPreviewHeader.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./OverlaySidebarGroup.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./FileEditorTab.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./NotesPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./SearchPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});
vi.mock("./browser/BrowserView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) }) };
});

async function loadRightPanel(): Promise<Component> {
  return (await import("./RightPanel.vue")).default;
}

async function mountRightPanel() {
  const component = await loadRightPanel();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(component) });
  app.mount(host);
  await nextTick();
  return { app, host };
}

describe("RightPanel routing", () => {
  let app: App | null = null;

  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens singleton views from global focus and source-control routes", async () => {
    const mounted = await mountRightPanel();
    app = mounted.app;
    expect(mounted.host.innerHTML).toContain("data-switch-history");

    window.dispatchEvent(new CustomEvent("focus-file-panel", { detail: "sc" }));
    window.dispatchEvent(new CustomEvent("focus-file-panel", { detail: "notes" }));
    mounted.host.querySelector<HTMLButtonElement>("[data-switch-history]")?.click();
    mounted.host.querySelector<HTMLButtonElement>("[data-jump-source]")?.click();
    await nextTick();

    expect(panel.api.openTabOfKind.mock.calls.map(([kind]: [string]) => kind)).toEqual([
      "sourceControl", "notes", "commits", "sourceControl",
    ]);
    expect(panel.api.openTabOfKind.mock.invocationCallOrder.at(-1))
      .toBeLessThan(rpc.gitDiff.mock.invocationCallOrder[0]);
  });

  it("reveals the activation-history candidate and opens an explorer only when none exists", async () => {
    const mounted = await mountRightPanel();
    app = mounted.app;

    panel.api.focusMostRecentFileOrExplorer.mockReturnValueOnce("/repo/recent.ts");
    window.dispatchEvent(new CustomEvent("focus-file-panel", { detail: "explorer" }));
    expect(panel.api.focusMostRecentFileOrExplorer).toHaveBeenCalledTimes(1);
    expect(panel.api.openTabOfKind).not.toHaveBeenCalledWith("explorer");

    panel.api.focusMostRecentFileOrExplorer.mockReturnValueOnce(null);
    window.dispatchEvent(new CustomEvent("focus-file-panel", { detail: "explorer" }));
    expect(panel.api.openTabOfKind).toHaveBeenCalledWith("explorer");
  });

  it("closes the active tab regardless of kind", async () => {
    const mounted = await mountRightPanel();
    app = mounted.app;

    window.dispatchEvent(new CustomEvent("close-active-file-tab"));
    expect(panel.api.closeTab).toHaveBeenCalledWith("__sc__");

    panel.api.tabs.value = [{ kind: "file", id: "/repo/a.ts", filePath: "/repo/a.ts", label: "a.ts" }];
    panel.api.activeId.value = "/repo/a.ts";
    await nextTick();
    window.dispatchEvent(new CustomEvent("close-active-file-tab"));
    expect(panel.api.closeTab).toHaveBeenCalledWith("/repo/a.ts");
  });
});
