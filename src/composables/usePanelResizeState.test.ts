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

  it("does not re-resize when the persisted size matches what it rendered with", async () => {
    // Resolves from the DB after the panel has painted, so a redundant resize
    // here shows up as the panel's contents shifting once it is already open.
    const { state } = make(900);
    await nextTick();
    const resize = vi.fn();
    state.panelRef.value = { expand: vi.fn(), collapse: vi.fn(), resize };
    state.applyPersisted("185");
    await nextTick();
    expect(resize).not.toHaveBeenCalled();
  });

  it("still applies a persisted size that differs from the cache", async () => {
    const { state } = make(900);
    await nextTick();
    const resize = vi.fn();
    state.panelRef.value = { expand: vi.fn(), collapse: vi.fn(), resize };
    state.applyPersisted("240");
    await nextTick();
    expect(resize).toHaveBeenCalledWith(240);
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

describe("usePanelResizeState without a visibleStateKey (e.g. search)", () => {
  const makeNoPersist = (width = 900) => {
    const containerWidth = ref(width);
    const state = usePanelResizeState({
      cacheKey: "search",
      pxStateKey: "search_list_px",
      initialPx: 220,
      clamp: (px: number) => px,
      containerWidth,
    });
    return { containerWidth, state };
  };

  it("still drives panelRef.expand()/collapse() while docked", async () => {
    const { state } = makeNoPersist(900);
    await nextTick();
    const expand = vi.fn();
    const collapse = vi.fn();
    state.panelRef.value = { expand, collapse };

    state.open.value = false;
    await nextTick();
    expect(collapse).toHaveBeenCalled();

    state.open.value = true;
    await nextTick();
    expect(expand).toHaveBeenCalled();
  });

  it("never calls setAppState for visibility (no persistence without visibleStateKey)", async () => {
    const { state } = makeNoPersist(900);
    await nextTick();
    state.panelRef.value = { expand: vi.fn(), collapse: vi.fn() };

    state.open.value = false;
    await nextTick();
    state.open.value = true;
    await nextTick();

    expect(setAppState).not.toHaveBeenCalled();
  });

  it("still auto-collapses a late-arriving panelRef when closed and docked", async () => {
    const { state } = makeNoPersist(900);
    await nextTick();
    state.open.value = false;
    await nextTick();

    const collapse = vi.fn();
    state.panelRef.value = { expand: vi.fn(), collapse };
    await nextTick();
    await nextTick();
    expect(collapse).toHaveBeenCalled();
  });
});
