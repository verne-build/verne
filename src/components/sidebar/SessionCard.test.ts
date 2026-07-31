// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import type { SessionRow } from "@/lib/sessionsView";

const store = {
  pendingPicker: false,
  focusedSessionId: null as string | null,
  selectedDirectoryId: "dir-1",
  tabRuntime: new Map<string, unknown>(),
  sessionLifecycle: new Map<string, string>(),
  sessionActivityAt: new Map<string, number>(),
  sessionName: vi.fn(() => "Fix sidebar cards"),
  arrangementFor: vi.fn(() => null),
  selectSession: vi.fn(),
  setTabScopePinnedLocal: vi.fn(),
  renameTab: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  archiveSession: vi.fn(async () => {}),
  unarchiveSession: vi.fn(async () => {}),
  markSessionUnread: vi.fn(),
};
const transparentProjectIcons = ref<Record<string, boolean>>({ "root-1": true });

vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => store }));
vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({ request: {
    tabSetScopePinned: vi.fn(async () => {}),
    tabsHasRunningChild: vi.fn(async () => false),
  } }),
}));
vi.mock("@/composables/useProjectIcons", () => ({
  useProjectIcons: () => ({
    icons: ref({ "root-1": "/project.png" }),
    transparentIcons: transparentProjectIcons,
  }),
}));
vi.mock("@/composables/useAgentIcon", () => ({ getAgentIcon: () => "/agent.svg" }));
vi.mock("@/platform", () => ({ ask: vi.fn(async () => true) }));

import SessionCard from "./SessionCard.vue";

const directory = {
  id: "dir-1",
  path: "/repo/worktree",
  name: "Worktree",
  createdAt: 0,
  sortOrder: 0,
  parentDirectoryId: "root-1",
};

function row(archived = false): SessionRow {
  return {
    tab: {
      id: archived ? "archived-1" : "live-1",
      directoryId: "dir-1",
      label: "1",
      cwd: "/repo/worktree",
      sortOrder: 0,
      createdAt: 0,
      lastAgentType: "claude",
      lastAgentState: "idle",
      ...(archived ? { archivedAt: 1, resumeAvailable: true } : {}),
    },
    directory,
    agentType: "claude",
  };
}

describe("SessionCard layout", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp> | null = null;

  async function mount(archived = false): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({
      render: () => h(SessionCard, {
        row: row(archived),
        branch: "feature/sidebar",
        rootName: "Verne",
        rootDirId: "root-1",
        isWorktree: true,
        now: 10,
      }),
    });
    app.mount(host);
    await nextTick();
  }

  beforeEach(() => {
    transparentProjectIcons.value = { "root-1": true };
    store.archiveSession.mockClear();
    store.unarchiveSession.mockClear();
    store.markSessionUnread.mockClear();
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    host?.remove();
    document.body.replaceChildren();
  });

  it("offers a compact outline archive action on live-card hover", async () => {
    await mount();

    const button = host.querySelector<HTMLElement>('[aria-label="Archive Session"]');
    expect(button?.dataset.variant).toBe("outline");
    expect(button?.dataset.size).toBe("xs");
    expect(button?.textContent?.trim()).toBe("Archive");
    expect(button?.classList.contains("h-5")).toBe(true);
    expect(button?.classList.contains("gap-1")).toBe(true);
    expect(button?.classList.contains("text-muted-foreground")).toBe(true);
    expect(button?.classList.contains("group-hover/card:opacity-100")).toBe(true);

    button?.click();
    await nextTick();
    expect(store.archiveSession).toHaveBeenCalledWith("live-1");
  });

  it("renders live session titles one pixel larger than archived titles", async () => {
    await mount();
    const liveTitle = Array.from(host.querySelectorAll<HTMLElement>("span"))
      .find((element) => element.textContent === "Fix sidebar cards");
    expect(liveTitle?.classList.contains("text-[13px]")).toBe(true);

    app?.unmount();
    host.remove();
    await mount(true);
    const archivedTitle = Array.from(host.querySelectorAll<HTMLElement>("span"))
      .find((element) => element.textContent?.trim() === "Fix sidebar cards");
    expect(archivedTitle?.classList.contains("text-xs")).toBe(true);
  });

  it("renders archived sessions as one line with project icon and session name", async () => {
    await mount(true);

    const card = Array.from(host.querySelectorAll<HTMLElement>("*"))
      .find((element) => element.classList.contains("group/card"));
    expect(card?.classList.contains("justify-start")).toBe(true);
    expect(host.querySelector('img[src="/project.png"]')).not.toBeNull();
    expect(host.textContent).toContain("Fix sidebar cards");
    expect(host.textContent).not.toContain("Verne");
    expect(host.textContent).not.toContain("feature/sidebar");
    expect(host.textContent).not.toContain("Archived");
    expect(host.querySelector('[aria-label="Archive Session"]')).toBeNull();
  });

  it("uses the hover-card ring on live and archived project icons", async () => {
    for (const archived of [false, true]) {
      await mount(archived);
      const image = host.querySelector('img[src="/project.png"]');
      expect(image?.classList.contains("ring-1")).toBe(true);
      expect(image?.classList.contains("ring-black/10")).toBe(true);
      expect(image?.classList.contains("dark:ring-white/10")).toBe(true);
      expect(image?.classList.contains("rounded-xs")).toBe(true);
      expect(image?.classList.contains("rounded-sm")).toBe(false);
      app?.unmount();
      app = null;
      host.remove();
    }
  });

  it("pads only project icons with transparent backgrounds", async () => {
    await mount();
    expect(host.querySelector('img[src="/project.png"]')?.classList.contains("p-0.5")).toBe(true);

    app?.unmount();
    app = null;
    host.remove();
    transparentProjectIcons.value = { "root-1": false };
    await mount();
    expect(host.querySelector('img[src="/project.png"]')?.classList.contains("p-0.5")).toBe(false);
  });

  it("reveals a right-aligned compact Resume action and truncates the title on hover", async () => {
    await mount(true);

    const button = host.querySelector<HTMLElement>('[aria-label="Resume Session"]');
    expect(button?.dataset.variant).toBe("outline");
    expect(button?.dataset.size).toBe("xs");
    expect(button?.textContent?.trim()).toBe("Resume");
    expect(button?.querySelector(".lucide-undo-2")).not.toBeNull();
    expect(button?.classList.contains("right-1.5")).toBe(true);
    expect(button?.classList.contains("group-hover/card:opacity-100")).toBe(true);

    const title = Array.from(host.querySelectorAll<HTMLElement>("span"))
      .find((element) => element.textContent === "Fix sidebar cards");
    expect(title?.classList.contains("truncate")).toBe(true);
    expect(title?.classList.contains("group-hover/card:pr-20")).toBe(true);

    button?.click();
    await nextTick();
    expect(store.unarchiveSession).toHaveBeenCalledWith("archived-1", true);
  });

  it("uses the same arrow icon for Resume Agent in the archived context menu", async () => {
    await mount(true);
    const card = Array.from(host.querySelectorAll<HTMLElement>("*"))
      .find((element) => element.classList.contains("group/card"));
    card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await nextTick();
    }

    const item = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]'))
      .find((element) => element.textContent?.trim() === "Resume Agent");
    expect(item?.querySelector(".lucide-undo-2")).not.toBeNull();
  });

  it("marks a live agent session unread from its context menu", async () => {
    await mount();
    const card = Array.from(host.querySelectorAll<HTMLElement>("*"))
      .find((element) => element.classList.contains("group/card"));
    card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await nextTick();
    }

    const item = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]'))
      .find((element) => element.textContent?.trim() === "Mark As Unread");
    expect(item).toBeTruthy();
    item?.click();
    await nextTick();
    expect(store.markSessionUnread).toHaveBeenCalledWith("live-1");
  });
});
