// @vitest-environment jsdom
import type { Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

const mocks = vi.hoisted(() => {
  const icons = { value: {} as Record<string, string> };
  const transparentIcons = { value: {} as Record<string, boolean> };
  return {
    icons,
    transparentIcons,
    loadIcon: vi.fn(async (directoryId: string) => {
      icons.value[directoryId] = directoryId === "project-source" ? "verne-asset://local/project.png" : "";
      transparentIcons.value[directoryId] = directoryId === "project-source";
    }),
    toast: vi.fn(),
    store: {
      directories: [
        { id: "project-current", path: "/repos/current", name: "Current" },
        { id: "project-source", path: "/repos/source", name: "Source" },
      ],
      selectedDirectoryId: "project-current",
      terminalTabsByDirectory: {
        "project-current": [{ id: "tab-current" }],
        "project-source": [{ id: "tab-source" }],
      },
      sessionName: vi.fn(() => "Background agent"),
      selectSession: vi.fn(),
    },
  };
});

vi.mock("vue-sonner", () => ({ toast: mocks.toast }));
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => mocks.store }));
vi.mock("@/composables/useProjectIcons", () => ({
  useProjectIcons: () => ({
    icons: mocks.icons,
    transparentIcons: mocks.transparentIcons,
    loadIcon: mocks.loadIcon,
  }),
}));
vi.mock("@/composables/useSettings", () => ({
  useSettings: () => ({ settings: { value: { notificationsInApp: true } } }),
}));
vi.mock("@/composables/useSettingsScreen", () => ({
  useSettingsScreen: () => ({ showSettings: { value: false } }),
}));

import {
  forgetAgentNotificationTab,
  unwireAgentNotifications,
  wireAgentNotifications,
} from "./useAgentNotifications";

function sendState(agentState: "working" | "idle"): void {
  window.dispatchEvent(new CustomEvent("tab-updated", {
    detail: { tabId: "tab-source", agentType: "claude", agentState },
  }));
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  mocks.icons.value = {};
  mocks.transparentIcons.value = {};
  mocks.loadIcon.mockClear();
  mocks.toast.mockClear();
  forgetAgentNotificationTab("tab-source");
  wireAgentNotifications();
});

afterEach(() => {
  unwireAgentNotifications();
  vi.restoreAllMocks();
});

describe("agent notification project icon", () => {
  it("loads and renders the icon for the notification's source project", async () => {
    sendState("working");
    sendState("idle");

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.loadIcon).toHaveBeenCalledWith("project-source", "/repos/source");

    const icon = mocks.toast.mock.calls[0]?.[1]?.icon as Component;
    const host = document.createElement("div");
    const app = createApp({ render: () => h(icon) });
    app.mount(host);
    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe("verne-asset://local/project.png");
    expect(image?.classList.contains("ring-1")).toBe(true);
    expect(image?.classList.contains("ring-black/10")).toBe(true);
    expect(image?.classList.contains("dark:ring-white/10")).toBe(true);
    expect(image?.classList.contains("rounded-xs")).toBe(true);
    expect(image?.classList.contains("rounded-sm")).toBe(false);
    expect(image?.classList.contains("p-0.5")).toBe(true);
    app.unmount();
  });
});
