import { onBeforeUnmount, ref, type Ref } from "vue";
import { setSplitterDragging } from "./useTerminal";
import {
  PANEL_ANIM_MS,
  beginPanelAnimation,
  endPanelAnimation,
  setSplitterDraggingState,
} from "@/lib/panelAnimationState";

export {
  PANEL_ANIM_MS,
  panelsAnimating,
  isSplitterDragging,
} from "@/lib/panelAnimationState";

/**
 * Handle a ResizableHandle's `@dragging`.
 *
 * `collapsible` panels snap shut when dragged below half their min size, which
 * reka reports back as a collapse. That's a real state change we mirror, but it
 * must never animate — the panel is already where the pointer left it.
 */
export function trackSplitterDrag(active: boolean): void {
  setSplitterDraggingState(active);
  setSplitterDragging(active);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

export interface PanelAnimation {
  /** True only while a toggle is in flight. */
  animating: Ref<boolean>;
  /** Start (or restart) the animation window. */
  begin: () => void;
}

/**
 * Gate for panel open/close animations.
 *
 * The CSS transition on `flex-grow` is applied ONLY while `animating` is true,
 * so a splitter drag — which never calls `begin()` — keeps its current
 * frame-exact behaviour. Layout persistence also skips in-flight sizes so a
 * collapse can't stomp the stored width with an intermediate value.
 *
 * Re-entrant: toggling mid-flight just restarts the window; CSS interrupts the
 * running transition from wherever it is.
 */
export function usePanelAnimation(onSettled?: () => void): PanelAnimation {
  const animating = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function settle(): void {
    if (!animating.value) return;
    animating.value = false;
    endPanelAnimation();
  }

  function begin(): void {
    if (prefersReducedMotion()) {
      onSettled?.();
      return;
    }
    // Re-entrant: a mid-flight toggle restarts the window without double-counting.
    if (!animating.value) {
      animating.value = true;
      beginPanelAnimation();
    }
    if (timer) clearTimeout(timer);
    // +30ms: transitionend can be missed when a panel's grow value doesn't
    // actually change (e.g. it was already at target), so drive off a timer.
    timer = setTimeout(() => {
      timer = null;
      settle();
      onSettled?.();
    }, PANEL_ANIM_MS + 30);
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    settle();
  });

  return { animating, begin };
}
