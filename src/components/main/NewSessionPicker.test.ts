// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { resetAgentAvailabilityCacheForTests } from "@/lib/agentRegistry";
import type { WorkingDirectory } from "@/types";

const rpc = vi.hoisted(() => ({
  agentBinsAvailable: vi.fn(),
  getDirectorySettings: vi.fn(),
  gitListBranches: vi.fn(),
  gitStatus: vi.fn(),
  gitCheckoutBranch: vi.fn(),
}));

const store = vi.hoisted(() => ({
  directories: [{
    id: "dir-1",
    path: "/Users/verne/project",
    name: "Project",
    createdAt: 0,
    sortOrder: 0,
  }] as WorkingDirectory[],
  selectedDirectoryId: "dir-1" as string | null,
  pendingPicker: { dirId: "dir-1" } as { dirId: string } | null,
  terminalTabsByDirectory: { "dir-1": [] as unknown[] },
  loadTabsForDirectory: vi.fn(async () => []),
  selectDirectory: vi.fn(),
  openSessionPicker: vi.fn(),
  closeSessionPicker: vi.fn(),
  startPickerSession: vi.fn(async (input: {
    mode: "current" | "worktree";
    branch: { isHead: boolean };
  }) => {
    if (input.mode === "current" && !input.branch.isHead)
      await rpc.gitCheckoutBranch();
  }),
}));

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({ request: rpc }),
}));

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => store,
}));

vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({ getActiveThemeSpec: () => ({ type: "dark" }) }),
}));

import NewSessionPicker from "./NewSessionPicker.vue";

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function menuItem(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-radio-item]"))
    .find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`Missing menu item: ${label}`);
  return match;
}

function actionMenuItem(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"))
    .find((element) => element.textContent?.includes(label));
  if (!match) throw new Error(`Missing action menu item: ${label}`);
  return match;
}

function namedButton(name: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!match) throw new Error(`Missing named button: ${name}`);
  return match;
}

async function openMenu(name: string): Promise<void> {
  namedButton(name).click();
  await flush();
}

describe("NewSessionPicker", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.getDirectorySettings.mockReset();
    rpc.gitListBranches.mockReset();
    rpc.gitStatus.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: ["agy"] });
    rpc.getDirectorySettings.mockResolvedValue({});
    rpc.gitListBranches.mockResolvedValue([
      { name: "main", fullRef: "refs/heads/main", isRemote: false, isHead: true },
      { name: "feature", fullRef: "refs/heads/feature", isRemote: false, isHead: false },
    ]);
    rpc.gitStatus.mockResolvedValue({ staged: [], unstaged: [], untracked: [{ path: "draft.ts", status: "A", added: 0, deleted: 0, isBinary: false }] });
    rpc.gitCheckoutBranch.mockReset();
    store.directories = [{ id: "dir-1", path: "/Users/verne/project", name: "Project", createdAt: 0, sortOrder: 0 }];
    store.selectedDirectoryId = "dir-1";
    store.pendingPicker = { dirId: "dir-1" };
    store.terminalTabsByDirectory = { "dir-1": [] };
    store.loadTabsForDirectory.mockClear();
    store.selectDirectory.mockReset();
    store.selectDirectory.mockImplementation((directory: { id: string }) => {
      store.selectedDirectoryId = directory.id;
    });
    store.openSessionPicker.mockReset();
    store.openSessionPicker.mockImplementation((dirId: string) => {
      store.pendingPicker = { dirId };
    });
    store.startPickerSession.mockClear();
    store.closeSessionPicker.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({ render: () => h(NewSessionPicker, { dirId: "dir-1" }) });
    app.use(createPinia());
    app.mount(host);
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    document.body.replaceChildren();
  });

  it("loads Agy after mount even when the shadcn Button focus target is unavailable", async () => {
    await flush();

    expect(rpc.agentBinsAvailable).toHaveBeenCalledOnce();
    expect(button("Agy")).toBeTruthy();
  });

  it("renders and selects the registry-first Claude result", async () => {
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: ["claude", "agy"] });
    app = createApp({ render: () => h(NewSessionPicker, { dirId: "dir-1" }) });
    app.use(createPinia());
    app.mount(host);
    await flush();

    expect(button("Claude")).toBeTruthy();
    expect(namedButton("Select Agent").textContent).toContain("Claude");
  });

  it("retargets the picker from the directory heading dropdown", async () => {
    app.unmount();
    host.replaceChildren();
    store.directories = [
      { id: "dir-1", path: "/Users/verne/project", name: "Project", createdAt: 0, sortOrder: 0 },
      { id: "wt-1", path: "/Users/verne/project-feature", name: "Feature", createdAt: 0, sortOrder: 1, parentDirectoryId: "dir-1" },
      { id: "dir-2", path: "/Users/verne/other", name: "Other", createdAt: 0, sortOrder: 2 },
    ];
    store.selectedDirectoryId = "dir-1";
    store.pendingPicker = { dirId: "dir-1" };
    app = createApp({ render: () => h(NewSessionPicker, { dirId: "dir-1" }) });
    app.use(createPinia());
    app.mount(host);
    await flush();

    expect(document.querySelector("h2")?.textContent).toContain("Start New Session In");
    expect(namedButton("Select Directory").textContent).toContain("Project");
    await openMenu("Select Directory");
    expect(document.body.textContent).toContain("Project / Feature");
    expect(document.body.textContent).toContain("~/project-feature");

    actionMenuItem("Project / Feature").click();

    expect(store.selectDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: "wt-1" }));
    expect(store.openSessionPicker).toHaveBeenCalledWith("wt-1");
    expect(store.pendingPicker).toEqual({ dirId: "wt-1" });
  });

  it("keeps a branch failure retryable when agent availability resolves later", async () => {
    let resolveAgents!: (value: { available: string[] }) => void;
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.gitListBranches.mockReset();
    rpc.agentBinsAvailable.mockImplementationOnce(() => new Promise((resolve) => { resolveAgents = resolve; }));
    rpc.gitListBranches.mockRejectedValueOnce(new Error("branches unavailable"));
    app = createApp({ render: () => h(NewSessionPicker, { dirId: "dir-1" }) });
    app.use(createPinia());
    app.mount(host);
    await flush();

    expect(document.body.textContent).toContain("Couldn't Load Branches");
    resolveAgents({ available: ["agy"] });
    await flush();

    expect(document.body.textContent).toContain("Couldn't Load Branches");
    rpc.gitListBranches.mockResolvedValue([
      { name: "main", fullRef: "refs/heads/main", isRemote: false, isHead: true },
    ]);
    button("Retry").click();
    await flush();

    expect(rpc.gitListBranches).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit Terminal selection when availability resolves late", async () => {
    let resolveBins!: (value: { available: string[] }) => void;
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockImplementationOnce(() => new Promise((resolve) => { resolveBins = resolve; }));
    app = createApp({ render: () => h(NewSessionPicker, { dirId: "dir-1" }) });
    app.use(createPinia());
    app.mount(host);
    await nextTick();

    await openMenu("Select Agent");
    menuItem("Terminal").click();
    resolveBins({ available: ["agy"] });
    await flush();

    expect(button("Terminal")).toBeTruthy();
  });

  it("disables Model and Effort for Terminal", async () => {
    await flush();
    await openMenu("Select Agent");
    menuItem("Terminal").click();
    await nextTick();

    expect(button("Model Default").disabled).toBe(true);
    expect(button("Effort Default").disabled).toBe(true);
  });

  it("preserves compatible effort and shows the selected Fast Mode", async () => {
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: ["claude"] });
    app = createApp({ render: () => h(NewSessionPicker, { dirId: "dir-1" }) });
    app.use(createPinia());
    app.mount(host);
    await flush();

    await openMenu("Select Model");
    menuItem("Sonnet").click();
    await flush();
    await openMenu("Select Effort Or Fast Mode");
    menuItem("Medium").click();
    await flush();
    await openMenu("Select Model");
    menuItem("Opus").click();
    await flush();

    expect(namedButton("Select Effort Or Fast Mode").textContent).toContain("Effort Medium");
    expect(namedButton("Select Effort Or Fast Mode").textContent).toContain("Fast Mode Off");

    await openMenu("Select Effort Or Fast Mode");
    menuItem("On").click();
    await flush();

    expect(namedButton("Select Effort Or Fast Mode").textContent).toContain("Fast Mode On");
  });

  it("waits for dirty-checkout confirmation before delegating checkout to the store", async () => {
    await flush();
    await openMenu("Select Branch");
    menuItem("feature").click();
    await nextTick();
    button("Start").click();
    await flush();

    expect(rpc.gitStatus).toHaveBeenCalledOnce();
    expect(store.startPickerSession).not.toHaveBeenCalled();
    expect(rpc.gitCheckoutBranch).not.toHaveBeenCalled();

    button("Switch And Start").click();
    await flush();

    expect(store.startPickerSession).toHaveBeenCalledOnce();
    expect(rpc.gitCheckoutBranch).toHaveBeenCalledOnce();
  });

  it("keeps the active start request valid through rapid repeated clicks", async () => {
    let resolveStart!: () => void;
    store.startPickerSession.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
    await flush();

    const start = button("Start");
    start.click();
    start.click();
    await flush();

    expect(store.startPickerSession).toHaveBeenCalledOnce();
    resolveStart();
    await flush();

    expect(store.closeSessionPicker).toHaveBeenCalledOnce();
    expect(button("Start").disabled).toBe(false);
  });
});
