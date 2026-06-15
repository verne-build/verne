// Cell-metric geometry for the grid terminal. Kept pure (no DOM) so the
// device-pixel alignment invariant can be unit-tested.
//
// Why device-align: the renderers snap every cell position to the device-pixel
// grid (`Math.round(v * dpr) / dpr`). If cellWidth is fractional, adjacent
// columns round to DIFFERENT device widths (e.g. 15 vs 16px at dpr=2), so the
// same glyph image is stretched into quads of varying width — glyphs visibly
// change size across columns. Aligning cellWidth/cellHeight so that
// `dim * dpr` is a whole number makes `col * dim * dpr` integer for every
// column, so `snap` is the identity and every cell is exactly the same size.

/** Round a CSS-px length so it lands on a whole device pixel (`len * dpr`
 *  integer), then convert back to CSS px. Never below 1 device px. */
export function deviceAlign(lenCss: number, dpr: number): number {
  const d = dpr || 1;
  return Math.max(1, Math.round(lenCss * d)) / d;
}

/** Cell advance width in CSS px, device-aligned. `advance` is the measured
 *  monospace advance (e.g. `ctx.measureText('M').width`). */
export function cellWidthFor(advance: number, dpr: number): number {
  return deviceAlign(advance, dpr);
}

/** Cell line-box height in CSS px, device-aligned. Mirrors the old formula
 *  (`max(size + 2, size * lineHeight)`) but snapped to the device grid. */
export function cellHeightFor(fontSize: number, lineHeight: number, dpr: number): number {
  return deviceAlign(Math.max(fontSize + 2, fontSize * lineHeight), dpr);
}

/** Grid dimensions for a laid-out terminal container. Returns null while the
 *  container is hidden or too small to fit a cell, avoiding a destructive 1x1
 *  PTY resize during transient layout states such as opening Settings. */
export function gridSizeFor(
  width: number,
  height: number,
  padding: number,
  metrics: { cellWidth: number; cellHeight: number },
): { cols: number; rows: number } | null {
  const usableWidth = width - 2 * padding;
  const usableHeight = height - 2 * padding;
  if (usableWidth < metrics.cellWidth || usableHeight < metrics.cellHeight) return null;
  return {
    cols: Math.floor(usableWidth / metrics.cellWidth),
    rows: Math.floor(usableHeight / metrics.cellHeight),
  };
}
