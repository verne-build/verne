// Shared cell color resolution so the Canvas2D and WebGL2 renderers produce
// pixel-identical foreground/background colors (inverse, bold-as-bright,
// minimum-contrast, faint/DIM). Kept renderer-agnostic and pure for testing.

import type { Cell } from './gridProtocol';
import { colorKind, FLAG, indexedColor } from './gridProtocol';
import { blendSrgb, resolveColor, withMinContrast, type Palette } from './palette';

/** Opacity applied to faint (DIM) glyphs, blended toward bg in sRGB to match
 *  xterm/VTE (matches xterm DIM_OPACITY). */
export const DIM_ALPHA = 0.5;

export interface CellColorOpts {
  /** Map bold ANSI 0-7 fg to the bright 8-15 variant. */
  boldIsBright: boolean;
  /** Minimum fg/bg contrast ratio to enforce (1 = off). */
  minContrast: number;
}

/** The cell background (after inverse), as a CSS color. */
export function cellBg(cell: Cell, palette: Palette): string {
  const inverse = (cell.flags & FLAG.INVERSE) !== 0;
  return resolveColor(inverse ? cell.fg : cell.bg, palette, inverse);
}

/** The cell foreground (after inverse, bold-as-bright, min-contrast, DIM) as a
 *  CSS color. DIM is folded in here (gamma-correct sRGB blend toward bg). */
export function cellFg(cell: Cell, palette: Palette, opts: CellColorOpts): string {
  const inverse = (cell.flags & FLAG.INVERSE) !== 0;
  let fgPacked = inverse ? cell.bg : cell.fg;
  if (
    opts.boldIsBright &&
    cell.flags & FLAG.BOLD &&
    !inverse &&
    colorKind(fgPacked) === 1 &&
    (fgPacked & 0xff) < 8
  ) {
    fgPacked = indexedColor((fgPacked & 0xff) + 8);
  }
  let fg = resolveColor(fgPacked, palette, !inverse);
  const dim = (cell.flags & FLAG.DIM) !== 0;
  const bg = resolveColor(inverse ? cell.fg : cell.bg, palette, inverse);
  if (opts.minContrast > 1 && !dim) fg = withMinContrast(fg, bg, opts.minContrast);
  if (dim) fg = blendSrgb(fg, bg, DIM_ALPHA);
  return fg;
}
