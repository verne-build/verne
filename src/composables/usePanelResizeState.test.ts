// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

const setAppState = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("./useRpc", () => ({ useRpc: () => ({ request: { setAppState } }) }));

const writeCachedPanelPx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/bootstrapCache", () => ({ writeCachedPanelPx }));

import { usePanelResizeState } from "./usePanelResizeState";

const make = (width = 0) => {
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
  return { containerWidth, state };
};

beforeEach(() => {
  writeCachedPanelPx.mockClear();
  setAppState.mockClear();
});

describe("usePanelResizeState overlay mode", () => {
  it("stays docked while the panel is wide", async () => {
    const { state } = make(900);
    await nextTick();
    expect(state.overlayMode.value).toBe(false);
    expect(state.open.value).toBe(true);
  });

  it("auto-collapses when the panel narrows", async () => {
    const { containerWidth, state } = make(900);
    await nextTick();
    containerWidth.value = 600;
    await nextTick();
    expect(state.overlayMode.value).toBe(true);
    expect(state.open.value).toBe(false);
    // The docked intent is untouched — that is what makes restore work.
    expect(state.visible.value).toBe(true);
  });

  it("restores the docked sidebar when the panel widens again", async () => {
    const { containerWidth, state } = make(600);
    await nextTick();
    expect(state.overlayMode.value).toBe(true);
    containerWidth.value = 900;
    await nextTick();
    expect(state.overlayMode.value).toBe(false);
    expect(state.open.value).toBe(true);
  });

  it("does not persist an overlay open/close", async () => {
    const { containerWidth, state } = make(900);
    await nextTick();
    containerWidth.value = 600;
    await nextTick();
    state.open.value = true;
    await nextTick();
    expect(state.overlayOpen.value).toBe(true);
    expect(state.visible.value).toBe(true);
    expect(setAppState).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "sc_list_visible" }),
    );
  });

  it("re-collapses the overlay after dismissing and re-entering", async () => {
    const { containerWidth, state } = make(600);
    await nextTick();
    state.open.value = true;
    state.dismissOverlay();
    expect(state.overlayOpen.value).toBe(false);
    containerWidth.value = 900;
    await nextTick();
    containerWidth.value = 600;
    await nextTick();
    expect(state.overlayOpen.value).toBe(false);
  });

  it("keeps a docked close persistent across a mode round-trip", async () => {
    const { containerWidth, state } = make(900);
    await nextTick();
    state.open.value = false;
    await nextTick();
    expect(state.visible.value).toBe(false);
    containerWidth.value = 600;
    await nextTick();
    containerWidth.value = 900;
    await nextTick();
    expect(state.open.value).toBe(false);
  });

  it("ignores layout sizes while overlaid", async () => {
    const { containerWidth, state } = make(900);
    await nextTick();
    state.onLayout([220]);
    expect(state.sizePx.value).toBe(220);
    writeCachedPanelPx.mockClear();
    containerWidth.value = 600;
    await nextTick();
    state.onLayout([400]);
    expect(state.sizePx.value).toBe(220);
    expect(writeCachedPanelPx).not.toHaveBeenCalled();
  });
});
