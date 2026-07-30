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
