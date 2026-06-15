// Custom scrollbar geometry (a canvas has no native scrollbar). Pure math; the
// host draws the slider and maps drags back to a scroll offset.

export interface SliderGeometry {
  /** Slider height in px. */
  size: number;
  /** Slider top offset within the track, in px. */
  pos: number;
  /** Whether the scrollbar is needed at all. */
  visible: boolean;
}

const MIN_SLIDER = 20;

/** Compute slider size/position. `scrollOffsetRows` is rows up from the bottom
 *  (0 = at bottom). */
export function sliderGeometry(
  visibleRows: number,
  totalRows: number,
  trackPx: number,
  scrollOffsetRows: number,
): SliderGeometry {
  if (totalRows <= visibleRows || trackPx <= 0) {
    return { size: trackPx, pos: 0, visible: false };
  }
  const size = Math.max(MIN_SLIDER, (trackPx * visibleRows) / totalRows);
  const maxScroll = totalRows - visibleRows;
  const clamped = Math.max(0, Math.min(maxScroll, scrollOffsetRows));
  // offset 0 → slider at bottom (pos = trackPx - size); offset max → top (pos 0).
  const pos = (1 - clamped / maxScroll) * (trackPx - size);
  return { size, pos, visible: true };
}

/** Track-Y (px) of a logical line's tick. Line 0 = top (oldest), totalRows =
 *  bottom. Same trackPx the slider uses (visibleRows * cellHeight). */
export function lineToTrackY(line: number, totalRows: number, trackPx: number): number {
  if (totalRows <= 0) return 0;
  return Math.max(0, Math.min(trackPx, (line / totalRows) * trackPx));
}

/** Map a slider-top position (px) back to a scroll offset in rows-from-bottom. */
export function positionToScrollOffset(
  posPx: number,
  size: number,
  trackPx: number,
  visibleRows: number,
  totalRows: number,
): number {
  const maxScroll = Math.max(0, totalRows - visibleRows);
  const travel = trackPx - size;
  if (travel <= 0) return 0;
  const frac = Math.max(0, Math.min(1, posPx / travel));
  return Math.round((1 - frac) * maxScroll);
}
