// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";

const store = {
  directories: [
    { id: "dir-1", path: "/a", name: "Project Alpha", createdAt: 0, sortOrder: 0 },
    { id: "dir-2", path: "/b", name: "Beta", createdAt: 0, sortOrder: 1 },
  ] as unknown[],
  selectedDirectoryId: "dir-1",
  picking: false,
  activityVersion: 0,
  terminalTabsByDirectory: {} as Record<string, unknown[]>,
  sessionActivityAt: new Map<string, number>(),
  tabRuntime: new Map<string, unknown>(),
  sessionsList: vi.fn(() => [] as unknown[]),
  sessionName: vi.fn(() => ""),
  openAndSelectWorkspace: vi.fn(),
  selectDirectory: vi.fn(),
  openSessionPicker: vi.fn(),
};

const rpc = { gitBranchName: vi.fn(async () => null), gitWatch: vi.fn(async () => {}) };
const projectIcons = ref<Record<string, string>>({});
const transparentProjectIcons = ref<Record<string, boolean>>({});

vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => store }));
vi.mock("@tanstack/vue-virtual", () => ({
  useVirtualizer: (options: { value: { count: number; getItemKey: (index: number) => string | number } }) => computed(() => ({
    getTotalSize: () => options.value.count * 40,
    getVirtualItems: () => Array.from({ length: options.value.count }, (_, index) => ({
      index,
      key: options.value.getItemKey(index),
      size: 40,
      start: index * 40,
    })),
    measureElement: () => {},
  })),
}));
vi.mock("@/composables/useRpc", () => ({ useRpc: () => ({ request: rpc }) }));
vi.mock("@/composables/useProjectIcons", () => ({
  useProjectIcons: () => ({ icons: projectIcons, transparentIcons: transparentProjectIcons }),
}));
vi.mock("@/composables/useScrollFades", () => ({
  useScrollFades: () => ({ bodyEl: ref(null), atStart: ref(true), atEnd: ref(true), update: () => {} }),
}));
vi.mock("@/platform", () => ({
  listen: vi.fn(async () => () => {}),
  ask: vi.fn(async () => true),
}));
vi.mock("./SessionCard.vue", () => ({ default: { render: () => null } }));

import SessionsSidebar from "./SessionsSidebar.vue";

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) { await Promise.resolve(); await nextTick(); }
}
function namedButton(name: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!el) throw new Error(`Missing button: ${name}`);
  return el;
}
function menuItemTexts(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"))
    .map((el) => el.textContent?.trim() ?? "");
}
async function openMenu(): Promise<void> { namedButton("Select Workspace").click(); await flush(); }
async function typeFilter(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("[data-slot=dropdown-menu-content] input")
    ?? document.querySelector<HTMLInputElement>("input[placeholder='Filter Workspaces…']");
  if (!input) throw new Error("Missing filter input");
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await flush();
}

describe("SessionsSidebar workspace dropdown", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    projectIcons.value = {};
    transparentProjectIcons.value = {};
    store.openAndSelectWorkspace.mockClear();
    store.sessionsList.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({ render: () => h(SessionsSidebar) });
    app.use(createPinia());
    app.mount(host);
  });
  afterEach(() => {
    app.unmount();
    host.remove();
    document.body.replaceChildren();
  });

  it("lists All Workspaces plus every root dir", async () => {
    await flush();
    await openMenu();
    const texts = menuItemTexts();
    expect(texts).toContain("All Workspaces");
    expect(texts).toContain("Project Alpha");
    expect(texts).toContain("Beta");
  });

  it("uses the shared project-icon corners and ring in the trigger and menu", async () => {
    projectIcons.value = { "dir-1": "/alpha.png", "dir-2": "/beta.png" };
    transparentProjectIcons.value = { "dir-1": true, "dir-2": false };
    await flush();
    await openMenu();

    const menuImages = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slot="dropdown-menu-content"] img'));
    expect(menuImages).toHaveLength(2);
    for (const image of menuImages) {
      expect(image.classList.contains("rounded-xs")).toBe(true);
      expect(image.classList.contains("rounded-sm")).toBe(false);
      expect(image.classList.contains("ring-1")).toBe(true);
      expect(image.classList.contains("ring-black/10")).toBe(true);
      expect(image.classList.contains("dark:ring-white/10")).toBe(true);
    }
    expect(menuImages.find((image) => image.src.endsWith("/alpha.png"))?.classList.contains("p-0.5")).toBe(true);
    expect(menuImages.find((image) => image.src.endsWith("/beta.png"))?.classList.contains("p-0.5")).toBe(false);

    const alpha = Array.from(document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"))
      .find((item) => item.textContent?.trim() === "Project Alpha");
    alpha!.click();
    await flush();
    const triggerImage = namedButton("Select Workspace").querySelector("img");
    expect(triggerImage?.classList.contains("rounded-xs")).toBe(true);
    expect(triggerImage?.classList.contains("ring-1")).toBe(true);
    expect(triggerImage?.classList.contains("ring-black/10")).toBe(true);
    expect(triggerImage?.classList.contains("dark:ring-white/10")).toBe(true);
    expect(triggerImage?.classList.contains("p-0.5")).toBe(true);
  });

  it("filters rows by query", async () => {
    await flush();
    await openMenu();
    await typeFilter("beta");
    const texts = menuItemTexts();
    expect(texts).toContain("Beta");
    expect(texts).not.toContain("Project Alpha");
  });

  it("selecting a workspace updates the trigger label", async () => {
    await flush();
    await openMenu();
    const beta = Array.from(document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"))
      .find((el) => el.textContent?.trim() === "Beta");
    beta!.click();
    await flush();
    expect(namedButton("Select Workspace").textContent).toContain("Beta");
    expect(namedButton("Select Workspace").textContent).not.toContain("All Workspaces");
  });

  it("add-workspace button opens the folder picker", async () => {
    await flush();
    namedButton("Add Workspace").click();
    expect(store.openAndSelectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("uses a Lucide chevron and omits the count from Archived", async () => {
    app.unmount();
    store.sessionsList.mockReturnValue([
      {
        tab: { id: "archived-1", archivedAt: 1 },
        directory: store.directories[0],
        agentType: null,
      },
    ]);
    app = createApp({ render: () => h(SessionsSidebar) });
    app.use(createPinia());
    app.mount(host);
    await flush();

    const trigger = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Archived"));
    expect(trigger?.querySelector(".lucide-chevron-right")).not.toBeNull();
    expect(trigger?.textContent?.trim()).toBe("Archived");
  });

  it("marks rows and the sizing container so the transition window can target them", async () => {
    app.unmount();
    store.sessionsList.mockReturnValue([
      { tab: { id: "live-1" }, directory: store.directories[0], agentType: null },
      { tab: { id: "live-2" }, directory: store.directories[0], agentType: null },
      { tab: { id: "archived-1", archivedAt: 1 }, directory: store.directories[0], agentType: null },
    ]);
    app = createApp({ render: () => h(SessionsSidebar) });
    app.use(createPinia());
    app.mount(host);
    await flush();

    expect(host.querySelectorAll("[data-session-row]").length).toBeGreaterThan(0);
    expect(host.querySelectorAll("[data-session-rows]").length).toBe(1);
  });


  it("no longer renders the hand-rolled archive height transition", async () => {
    await flush();
    expect(host.innerHTML).not.toContain("transition-[height]");
  });
});
