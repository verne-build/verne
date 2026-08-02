import { computed, ref, watch } from "vue";

/** Panel open/close duration. Keep in sync with the `panel-anim` CSS rules. */
export const PANEL_ANIM_MS = 180;

/**
 * Shared panel-slide state.
 *
 * Deliberately dependency-free: it's read by width-derived layout rules deep in
 * the right panel, which must not have to pull the terminal/settings graph in
 * behind it.
 */
const activeCount = ref(0);
const splitterDragging = ref(false);

/**
 * True while ANY panel is mid-slide.
 *
 * Width-derived layout decisions (see usePanelResizeState's docked/overlay
 * rule) must not be re-evaluated against the intermediate widths a slide sweeps
 * through — they'd flip modes on the way past. Consumers freeze on this and
 * re-decide once it clears, at the settled width.
 */
export const panelsAnimating = computed(() => activeCount.value > 0);

export function beginPanelAnimation(): void {
  activeCount.value += 1;
}

export function endPanelAnimation(): void {
  activeCount.value = Math.max(0, activeCount.value - 1);
}

/**
 * True while the RIGHT panel specifically is sliding.
 *
 * The pane header's trailing actions have to clear out for that slide — the
 * persistent control strip's Maximize button lands in the same slot as the
 * pane's split menu — but they should sit still through a left or bottom slide,
 * which doesn't touch them.
 */
const rightSliding = ref(false);

export const rightPanelSliding = computed(() => rightSliding.value);

export function setRightPanelSliding(active: boolean): void {
  rightSliding.value = active;
}

/** True while any splitter handle is being dragged. */
export function isSplitterDragging(): boolean {
  return splitterDragging.value;
}

export function setSplitterDraggingState(active: boolean): void {
  splitterDragging.value = active;
}

/**
 * Terminals with a resize in flight.
 *
 * A grid resize lands well after the slide does — the ResizeObserver burst is
 * debounced, and the controller then holds the pre-resize frame until the
 * program repaints (or its deadline fires). Anything covering the reflow has to
 * wait for this, not for the slide.
 *
 * Counted for every resize, not just slide-driven ones; readers gate on their
 * own state, so an unrelated window resize just moves a number nobody reads.
 */
const pendingGridResizes = ref(0);

export const gridResizePending = computed(() => pendingGridResizes.value > 0);

export function beginGridResize(): void {
  pendingGridResizes.value += 1;
}

export function endGridResize(): void {
  pendingGridResizes.value = Math.max(0, pendingGridResizes.value - 1);
}

/**
 * Whether terminal grids should be covered (blurred + dimmed) to disguise their
 * reflow.
 *
 * Raised the moment a slide starts and held until the grid has actually
 * re-fitted — which lands well after the slide, once the resize debounce and the
 * controller's frame hold have both run. Releasing on a fixed delay uncovers a
 * still-reflowing grid.
 */
const COVER_MAX_MS = 1200;
/** ResizeObserver delivers asynchronously, so a grid resize triggered by the
 *  slide can still be unreported at the instant the slide ends. Uncovering on
 *  that empty moment would expose the reflow — wait a beat for it to show up. */
const COVER_GRACE_MS = 120;
const coverActive = ref(false);
let coverTimer: ReturnType<typeof setTimeout> | null = null;
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let sawGridResize = false;

export const slideCoverActive = computed(() => coverActive.value);

function clearGrace(): void {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = null;
}

function scheduleUncover(delay: number): void {
  if (graceTimer) return;
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (!panelsAnimating.value && !gridResizePending.value) uncover();
  }, delay);
}

function uncover(): void {
  coverActive.value = false;
  if (coverTimer) clearTimeout(coverTimer);
  coverTimer = null;
  clearGrace();
}

// Module-level and never stopped: this state lives as long as the app does.
watch([panelsAnimating, gridResizePending], ([sliding, gridSettling]) => {
  if (sliding) {
    coverActive.value = true;
    sawGridResize = false;
    clearGrace();
    // Backstop: a grid that never reports a commit can't strand the cover.
    if (coverTimer) clearTimeout(coverTimer);
    coverTimer = setTimeout(() => {
      coverTimer = null;
      coverActive.value = false;
    }, COVER_MAX_MS);
    return;
  }
  if (!coverActive.value) return;
  if (gridSettling) {
    // The grid has taken over: hold until it reports its commit.
    sawGridResize = true;
    clearGrace();
    return;
  }
  // Committed → uncover straight away; holding past the commit to mask a slow
  // agent's blank frame just made every other agent feel sluggish.
  if (sawGridResize) {
    uncover();
    return;
  }
  // Never reported → give the observer a beat in case one is still on its way.
  scheduleUncover(COVER_GRACE_MS);
});
