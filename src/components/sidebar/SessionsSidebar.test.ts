// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
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

vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => store }));
vi.mock("@/composables/useRpc", () => ({ useRpc: () => ({ request: rpc }) }));
vi.mock("@/composables/useProjectIcons", () => ({ useProjectIcons: () => ({ icons: ref({}) }) }));
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

  it("uses the filled disclosure caret for Archived", async () => {
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
    const caret = trigger?.firstElementChild;

    expect(caret?.tagName).toBe("SPAN");
    expect(caret?.classList.contains("border-l-[5px]")).toBe(true);
  });
});
