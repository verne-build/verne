import { PANEL_SIZES } from "./panelSizes";

/** Docked vs overlay for one inner sidebar.
 *
 *  `sidebarPx` is the *remembered* docked width, never the live rendered one —
 *  an overlaid sidebar is out of flow, so measuring it would make this rule
 *  self-referential. Asymmetric thresholds give hysteresis: the panel must be
 *  dragged clear of the band to re-dock, so hovering on the boundary can't
 *  flip modes every frame. Width 0 means not measured yet — hold the mode. */
export function nextOverlayMode(
  current: boolean,
  containerWidth: number,
  sidebarPx: number,
): boolean {
  if (containerWidth <= 0) return current;
  const content = containerWidth - sidebarPx;
  const { contentMin, hysteresis } = PANEL_SIZES.overlay;
  return content < contentMin + (current ? hysteresis : 0);
}

/** Rendered width of an overlaid sidebar — its docked width, clamped so a
 *  peek strip of content stays visible and it never shrinks past the list min. */
export function overlayWidth(sizePx: number, containerWidth: number): number {
  if (containerWidth <= 0) return sizePx;
  return Math.max(
    PANEL_SIZES.list.min,
    Math.min(sizePx, containerWidth - PANEL_SIZES.overlay.peek),
  );
}

/** Width the docked/overlay rule should judge against.
 *
 *  The live measurement sweeps while a panel slides, and deciding against those
 *  intermediate widths flips the sidebar on the way past. Every slide that
 *  changes this width has a knowable target, though — so callers pass it and the
 *  rule judges the destination from the first frame, letting the panel animate
 *  in already in its final configuration instead of rearranging afterwards.
 *  Falls back to the measurement when no target is known. */
export function judgedWidth(
  measured: number,
  target: number | undefined,
  sliding: boolean,
): number {
  return sliding && target != null && target > 0 ? target : measured;
}
