// @vitest-environment jsdom
// endMode="close" (bottom panel scratch terminals) must never orphan a pane:
// dropping one from its bottom arrangement would make surfaceKeyFor resolve it
// to the CENTER, promoting a scratch terminal into the sessions pool.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";

const store = {
  terminalTabsByDirectory: {
    "dir-1": [{ id: "pane-1", directoryId: "dir-1", label: "1", cwd: null }],
  } as Record<string, unknown[]>,
  tabRuntime: new Map<string, { foregroundCommand?: string }>(),
  sessionLifecycle: new Map<string, string>(),
  focusedByScope: {} as Record<string, string | undefined>,
  splittableSessions: vi.fn(() => [] as unknown[]),
  sessionName: vi.fn(() => "pane"),
  focusSession: vi.fn(),
  syncViewportSize: vi.fn(),
  markSessionRunning: vi.fn(),
  removeFromView: vi.fn(),
  closeBottomPane: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  archiveSession: vi.fn(async () => {}),
  unarchiveSession: vi.fn(async () => {}),
};

const ask = vi.fn(async (_title: string, _opts: unknown) => true);
const tabsHasRunningChild = vi.fn(async (_p: { id: string }) => true);

vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => store }));
vi.mock("@/platform", () => ({ ask: (title: string, opts: unknown) => ask(title, opts) }));
vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      tabsSessionId: vi.fn(async () => null),
      tabsResume: vi.fn(async () => null),
      tabsHasRunningChild: (p: { id: string }) => tabsHasRunningChild(p),
    },
  }),
}));
vi.mock("@/composables/useTerminal", () => ({
  incrementMountedTerminalViewCount: vi.fn(),
  decrementMountedTerminalViewCount: vi.fn(),
}));
vi.mock("@/composables/useShortcuts", () => ({
  useShortcuts: () => ({ displayKeys: () => [] }),
}));
vi.mock("@/composables/useAgentIcon", () => ({
  agentIconSurfaceForTheme: () => "light",
  getAgentIconForSurface: () => null,
}));
vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({ activeThemeName: ref("x"), getActiveThemeSpec: () => ({ type: "dark" }) }),
}));
vi.mock("@/components/terminal/GridTerminal.vue", () => ({ default: { render: () => null } }));

import TerminalPane from "./TerminalPane.vue";

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function buttonByTitle(title: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
}

describe("TerminalPane end mode", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp> | null = null;

  type PaneProps = InstanceType<typeof TerminalPane>["$props"];
  function mount(props: PaneProps) {
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({ render: () => h(TerminalPane, props) });
    app.mount(host);
  }

  beforeEach(() => {
    store.removeFromView.mockClear();
    store.closeBottomPane.mockClear();
    ask.mockClear();
    tabsHasRunningChild.mockClear();
    store.tabRuntime.clear();
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    host?.remove();
    document.body.replaceChildren();
  });

  it("archive mode keeps Remove From View on the split close button", async () => {
    mount({ paneId: "pane-1", scopeId: "dir-1", multi: true });
    await flush();

    const btn = buttonByTitle("Remove From View");
    expect(btn).toBeTruthy();
    btn!.click();
    await flush();

    expect(store.removeFromView).toHaveBeenCalledWith("pane-1");
    expect(store.closeBottomPane).not.toHaveBeenCalled();
  });

  it("close mode kills the pane instead of orphaning it into the center", async () => {
    store.tabRuntime.set("pane-1", { foregroundCommand: "vim" });
    mount({
      paneId: "pane-1",
      scopeId: "bottom:dir-1:bt-1",
      multi: true,
      endMode: "close",
    });
    await flush();

    expect(buttonByTitle("Remove From View")).toBeNull();
    const btn = buttonByTitle("Close Terminal");
    expect(btn).toBeTruthy();
    btn!.click();
    await flush();

    // Running-process confirm, then a real kill — never removeFromView.
    expect(tabsHasRunningChild).toHaveBeenCalledWith({ id: "pane-1" });
    expect(ask).toHaveBeenCalledWith(
      "Close Terminal?",
      expect.objectContaining({ detail: expect.stringContaining("vim is still running") }),
    );
    expect(store.closeBottomPane).toHaveBeenCalledWith("pane-1");
    expect(store.removeFromView).not.toHaveBeenCalled();
  });

  it("declining the confirm leaves the pane alone", async () => {
    ask.mockResolvedValueOnce(false);
    mount({ paneId: "pane-1", scopeId: "bottom:dir-1:bt-1", multi: true, endMode: "close" });
    await flush();

    buttonByTitle("Close Terminal")!.click();
    await flush();

    expect(store.closeBottomPane).not.toHaveBeenCalled();
  });
});
