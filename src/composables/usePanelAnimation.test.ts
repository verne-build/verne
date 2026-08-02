// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, nextTick } from "vue";

vi.mock("./useTerminal", () => ({ setSplitterDragging: vi.fn() }));

import {
  usePanelAnimation,
  trackSplitterDrag,
  isSplitterDragging,
  PANEL_ANIM_MS,
} from "./usePanelAnimation";
import { setSplitterDragging } from "./useTerminal";

function withSetup<T>(fn: () => T): { result: T; unmount: () => void } {
  let result!: T;
  const app = createApp(
    defineComponent({
      setup() {
        result = fn();
        return () => null;
      },
    }),
  );
  app.mount(document.createElement("div"));
  return { result, unmount: () => app.unmount() };
}

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches }) as unknown as typeof window.matchMedia;
}

describe("usePanelAnimation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotion(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    trackSplitterDrag(false);
  });

  it("is animating only for the duration of a toggle", () => {
    const { result } = withSetup(() => usePanelAnimation());
    expect(result.animating.value).toBe(false);
    result.begin();
    expect(result.animating.value).toBe(true);
    vi.advanceTimersByTime(PANEL_ANIM_MS);
    expect(result.animating.value).toBe(true);
    vi.advanceTimersByTime(50);
    expect(result.animating.value).toBe(false);
  });

  it("runs onSettled once when the slide lands", () => {
    const settled = vi.fn();
    const { result } = withSetup(() => usePanelAnimation(settled));
    result.begin();
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PANEL_ANIM_MS + 50);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("restarts the window when toggled mid-flight", () => {
    const settled = vi.fn();
    const { result } = withSetup(() => usePanelAnimation(settled));
    result.begin();
    vi.advanceTimersByTime(100);
    result.begin();
    vi.advanceTimersByTime(120);
    // The first window's deadline has passed, but it was superseded.
    expect(result.animating.value).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(result.animating.value).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("skips the animation entirely under prefers-reduced-motion", () => {
    setReducedMotion(true);
    const settled = vi.fn();
    const { result } = withSetup(() => usePanelAnimation(settled));
    result.begin();
    expect(result.animating.value).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("clears its timer on unmount", async () => {
    const settled = vi.fn();
    const { result, unmount } = withSetup(() => usePanelAnimation(settled));
    result.begin();
    unmount();
    await nextTick();
    vi.advanceTimersByTime(1000);
    expect(settled).not.toHaveBeenCalled();
  });

  it("tracks splitter drags and still forwards to the terminal hook", () => {
    expect(isSplitterDragging()).toBe(false);
    trackSplitterDrag(true);
    expect(isSplitterDragging()).toBe(true);
    expect(setSplitterDragging).toHaveBeenCalledWith(true);
    trackSplitterDrag(false);
    expect(isSplitterDragging()).toBe(false);
  });
});
