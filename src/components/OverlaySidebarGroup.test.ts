// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createApp, defineComponent, h, ref, nextTick } from "vue";

// The composable imports "./useRpc" from src/composables; mocks resolve by
// module id, so the alias path targets the same file.
vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({ request: { setAppState: vi.fn(() => Promise.resolve(null)) } }),
}));

import { usePanelResizeState } from "@/composables/usePanelResizeState";
import OverlaySidebarGroup from "./OverlaySidebarGroup.vue";

function mount(width: number) {
  const containerWidth = ref(width);
  const state = usePanelResizeState({
    cacheKey: "scList",
    pxStateKey: "panel_sc_list_px",
    initialPx: 185,
    clamp: (px: number) => px,
    visibleStateKey: "sc_list_visible",
    initialVisible: true,
    containerWidth,
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(defineComponent({
    setup: () => () => h(OverlaySidebarGroup, { state, containerWidth: containerWidth.value }, {
      sidebar: () => h("div", { "data-sidebar": "1" }),
      content: () => h("div", { "data-content": "1" }),
    }),
  }));
  app.mount(host);
  return { host, app, state, containerWidth };
}

describe("OverlaySidebarGroup", () => {
  it("renders docked with no scrim on a wide panel", async () => {
    const { host, app } = mount(900);
    await nextTick();
    expect(host.querySelector(".overlay-mode")).toBeNull();
    expect(host.querySelector("[data-overlay-scrim]")).toBeNull();
    app.unmount();
  });

  it("marks overlay mode and keeps the sidebar mounted when narrow", async () => {
    const { host, app } = mount(600);
    await nextTick();
    expect(host.querySelector(".overlay-mode")).not.toBeNull();
    expect(host.querySelector("[data-sidebar]")).not.toBeNull();
    expect(host.querySelector("[data-overlay-scrim]")).toBeNull();
    app.unmount();
  });

  it("shows a scrim when the overlay is opened, and closes on scrim click", async () => {
    const { host, app, state } = mount(600);
    await nextTick();
    state.open.value = true;
    await nextTick();
    const scrim = host.querySelector("[data-overlay-scrim]") as HTMLElement;
    expect(scrim).not.toBeNull();
    scrim.click();
    await nextTick();
    expect(state.overlayOpen.value).toBe(false);
    app.unmount();
  });

  it("closes the overlay on Escape", async () => {
    const { app, state } = mount(600);
    await nextTick();
    state.open.value = true;
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(state.overlayOpen.value).toBe(false);
    app.unmount();
  });
});
