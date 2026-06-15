// Pure render-model layer for the WebGL2 renderer: per-row instance lists
// built from Cell[] — no GL, no DOM (glyph rasterization is injected), so the
// geometry/coalescing/trimming logic is unit-testable in node.

import { ANY_UNDERLINE, FLAG, type Cell } from './gridProtocol';
import { cellBg, cellFg } from './cellColor';
import { resolveColor, type Palette } from './palette';
import { drawBoxGlyph, isBoxGlyph } from './boxGlyph';
import type { FontMetrics } from './renderer';

export const RECT_F = 8; // x,y,w,h, r,g,b,a
export const GLYPH_F = 12; // x,y,w,h, u0,v0,u1,v1, r,g,b,a

export type Rgba = [number, number, number, number];

function parseCssRgba(css: string): Rgba {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, 1];
  if (css[0] === '#' && css.length >= 7) {
    return [
      parseInt(css.slice(1, 3), 16) / 255,
      parseInt(css.slice(3, 5), 16) / 255,
      parseInt(css.slice(5, 7), 16) / 255,
      1,
    ];
  }
  return [1, 1, 1, 1];
}

// Memoized: paint touches this per cell per rebuild. Shared result arrays —
// callers must only read. Cap guards pathological truecolor gradients.
const rgbaCache = new Map<string, Rgba>();
export function cssToRgba(css: string): Rgba {
  let hit = rgbaCache.get(css);
  if (hit) return hit;
  if (rgbaCache.size >= 4096) rgbaCache.clear();
  hit = parseCssRgba(css);
  rgbaCache.set(css, hit);
  return hit;
}

/** Growable Float32Array instance sink. Persists across paints; reset() is O(1). */
export class InstanceList {
  readonly stride: number;
  buf: Float32Array;
  count = 0;

  constructor(stride: number, initialInstances = 64) {
    this.stride = stride;
    this.buf = new Float32Array(stride * initialInstances);
  }

  reset(): void {
    this.count = 0;
  }

  private ensure(extraInstances = 1): void {
    const need = (this.count + extraInstances) * this.stride;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf);
    this.buf = next;
  }

  pushRect(x: number, y: number, w: number, h: number, c: Rgba): void {
    this.ensure();
    const a = this.buf;
    let i = this.count * this.stride;
    a[i++] = x; a[i++] = y; a[i++] = w; a[i++] = h;
    a[i++] = c[0]; a[i++] = c[1]; a[i++] = c[2]; a[i] = c[3];
    this.count++;
  }

  pushGlyph(
    x: number, y: number, w: number, h: number,
    u0: number, v0: number, u1: number, v1: number, c: Rgba,
  ): void {
    this.ensure();
    const a = this.buf;
    let i = this.count * this.stride;
    a[i++] = x; a[i++] = y; a[i++] = w; a[i++] = h;
    a[i++] = u0; a[i++] = v0; a[i++] = u1; a[i++] = v1;
    a[i++] = c[0]; a[i++] = c[1]; a[i++] = c[2]; a[i] = c[3];
    this.count++;
  }

  /** Append another list's filled prefix (same stride). */
  append(other: InstanceList): void {
    this.ensure(other.count);
    this.buf.set(other.view(), this.count * this.stride);
    this.count += other.count;
  }

  /** The filled prefix (count*stride floats). */
  view(): Float32Array {
    return this.buf.subarray(0, this.count * this.stride);
  }
}

export interface RowModel {
  bg: InstanceList;
  deco: InstanceList;
  box: InstanceList;
  fg: InstanceList;
  emoji: InstanceList;
  run: InstanceList;
}

export function makeRowModel(): RowModel {
  return {
    bg: new InstanceList(RECT_F, 16),
    deco: new InstanceList(RECT_F, 8),
    box: new InstanceList(RECT_F, 8),
    fg: new InstanceList(GLYPH_F, 64),
    emoji: new InstanceList(GLYPH_F, 4),
    run: new InstanceList(GLYPH_F, 8),
  };
}

export interface RowBuildCtx {
  y: number; // row top, CSS px
  cols: number;
  metrics: FontMetrics;
  dpr: number;
  palette: Palette;
  colorOpts: { boldIsBright: boolean; minContrast: number };
  ligatures: boolean;
  atlasW: number;
  atlasH: number;
  runAtlasW: number;
  runAtlasH: number;
  /** Rasterize (or look up) a glyph; returns its slot origin + content width
   *  (device px). A width-1 emoji reports a wider-than-cell width so it can
   *  overhang the trailing cell instead of being clipped. */
  ensureGlyph(cell: Cell): { x: number; y: number; w: number };
  /** Rasterize (or look up) a shaped run; null = atlas full → per-glyph fallback. */
  ensureRun(text: string, bold: boolean, italic: boolean):
    { x: number; y: number; w: number; h: number } | null;
  isEmoji(cell: Cell): boolean;
}

const glyphText = (cell: Cell): string => {
  let s = String.fromCodePoint(cell.cp);
  if (cell.zw) for (const c of cell.zw) s += String.fromCodePoint(c);
  return s;
};

/** Box glyphs needing AA curves (rounded corners / diagonals) go through the
 *  glyph atlas; everything else is procedural rects that tile seamlessly. */
const isSmoothBox = (cp: number): boolean =>
  (cp >= 0x256d && cp <= 0x2570) || (cp >= 0x2571 && cp <= 0x2573);

/** Build one row's instance lists from its cells. Mirrors the layering the
 *  renderer draws: bg runs (default-bg skipped — the frame clear covers it),
 *  decorations, procedural box rects, atlas glyphs, emoji, ligature runs. */
export function buildRow(cells: Cell[], ctx: RowBuildCtx, out: RowModel): void {
  const { cellWidth, cellHeight } = ctx.metrics;
  const y = ctx.y;
  const snap = (v: number) => Math.round(v * ctx.dpr) / ctx.dpr;
  const rect = (l: InstanceList, x: number, yy: number, w: number, h: number, c: Rgba) => {
    const x0 = snap(x), y0 = snap(yy);
    l.pushRect(x0, y0, snap(x + w) - x0, snap(yy + h) - y0, c);
  };
  out.bg.reset(); out.deco.reset(); out.box.reset();
  out.fg.reset(); out.emoji.reset(); out.run.reset();

  const defaultBgCss = ctx.palette.background;

  // Pass 1: background runs (coalesced; default skipped) + decorations.
  let runX = -1;
  let runW = 0;
  let runC: Rgba | null = null;
  let runCss = '';
  const flushBg = () => {
    if (runC) rect(out.bg, runX, y, runW, cellHeight, runC);
    runC = null;
    runW = 0;
  };
  for (let col = 0; col < cells.length; col++) {
    const cell = cells[col];
    if (cell.width === 0) continue;
    const span = cell.width === 2 ? 2 : 1;
    const x = col * cellWidth;
    const bgCss = cellBg(cell, ctx.palette);
    if (bgCss === runCss && runC) {
      runW += span * cellWidth;
    } else {
      flushBg();
      runCss = bgCss;
      if (bgCss !== defaultBgCss) {
        runC = cssToRgba(bgCss);
        runX = x;
        runW = span * cellWidth;
      }
    }
    if (cell.flags & (ANY_UNDERLINE | FLAG.STRIKEOUT)) {
      pushDecorations(out.deco, cell, x, y, ctx, rect);
    }
  }
  flushBg();

  // Pass 2: glyphs (per-glyph, emoji, procedural box, ligature runs).
  const glyph = (l: InstanceList, x: number, yy: number, cell: Cell, c: Rgba, span: number) => {
    const r = ctx.ensureGlyph(cell);
    // A width-1 emoji rasterizes wider than its cell (fallback color-emoji font),
    // so draw at the glyph's real width — it overhangs the trailing cell rather
    // than clipping to half. All other glyphs keep their exact cell-span width.
    const overhang = span === 1 && ctx.isEmoji(cell);
    const inkW = overhang ? r.w : span * cellWidth * ctx.dpr;
    const inkH = cellHeight * ctx.dpr;
    const wCss = inkW / ctx.dpr;
    const x0 = snap(x), y0 = snap(yy);
    l.pushGlyph(
      x0, y0, snap(x + wCss) - x0, snap(yy + cellHeight) - y0,
      r.x / ctx.atlasW, r.y / ctx.atlasH,
      (r.x + inkW) / ctx.atlasW, (r.y + inkH) / ctx.atlasH,
      c,
    );
  };

  let boxColor: Rgba = [1, 1, 1, 1];
  const boxCtx = {
    set fillStyle(v: string | CanvasGradient | CanvasPattern) {
      if (typeof v === 'string') boxColor = cssToRgba(v);
    },
    get fillStyle(): string | CanvasGradient | CanvasPattern {
      return '#fff';
    },
    fillRect: (x: number, yy: number, w: number, h: number) =>
      rect(out.box, x, yy, w, h, boxColor),
  };

  let ligStart = -1;
  let ligEnd = -1;
  let ligText = '';
  let ligColor: Rgba = [0, 0, 0, 0];
  let ligStyle = 0;
  const flushLig = () => {
    if (ligStart < 0) return;
    const trimmed = ligText.replace(/\s+$/u, '');
    if (trimmed.length) {
      const bold = (ligStyle & FLAG.BOLD) !== 0;
      const italic = (ligStyle & FLAG.ITALIC) !== 0;
      const r = ctx.ensureRun(trimmed, bold, italic);
      if (r) {
        const x0 = snap(ligStart * cellWidth), y0 = snap(y);
        out.run.pushGlyph(
          x0, y0,
          snap((ligStart + trimmed.length) * cellWidth) - x0,
          snap(y + cellHeight) - y0,
          r.x / ctx.runAtlasW, r.y / ctx.runAtlasH,
          (r.x + r.w) / ctx.runAtlasW, (r.y + r.h) / ctx.runAtlasH,
          ligColor,
        );
      } else {
        // Run atlas full this frame → per-glyph fallback (ligatures skipped).
        for (let c = ligStart; c < ligEnd; c++) {
          const cl = cells[c];
          if (!cl || cl.width === 0 || cl.cp === 32 || cl.cp === 0) continue;
          glyph(out.fg, c * cellWidth, y, cl, ligColor, 1);
        }
      }
    }
    ligStart = -1;
    ligEnd = -1;
    ligText = '';
  };
  const sameColor = (a: Rgba, b: Rgba) =>
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

  for (let col = 0; col < cells.length; col++) {
    const cell = cells[col];
    if (cell.width === 0) continue;
    const span = cell.width === 2 ? 2 : 1;
    const x = col * cellWidth;
    const hidden = (cell.flags & FLAG.HIDDEN) !== 0;
    const isBox = isBoxGlyph(cell.cp);
    const emoji = ctx.isEmoji(cell);
    const breaks =
      !ctx.ligatures || span === 2 || (cell.flags & FLAG.INVERSE) !== 0 || hidden || isBox || emoji;
    if (breaks) {
      flushLig();
      if (!hidden && cell.cp !== 32 && cell.cp !== 0) {
        const fgCss = cellFg(cell, ctx.palette, ctx.colorOpts);
        if (isBox && !isSmoothBox(cell.cp)) {
          boxCtx.fillStyle = fgCss;
          drawBoxGlyph(
            boxCtx, cell.cp, x, y, span * cellWidth, cellHeight,
            ctx.dpr, ctx.metrics.baseline, ctx.metrics.fontSize,
          );
        } else if (emoji) {
          glyph(out.emoji, x, y, cell, cssToRgba(fgCss), span);
        } else {
          glyph(out.fg, x, y, cell, cssToRgba(fgCss), span);
        }
      }
      continue;
    }
    const fgC = cssToRgba(cellFg(cell, ctx.palette, ctx.colorOpts));
    const style = cell.flags & (FLAG.BOLD | FLAG.ITALIC);
    if (ligStart >= 0 && (style !== ligStyle || !sameColor(fgC, ligColor))) flushLig();
    if (ligStart < 0) {
      ligStart = col;
      ligColor = fgC;
      ligStyle = style;
    }
    ligEnd = col + span;
    ligText += cell.cp === 0 ? ' ' : glyphText(cell);
  }
  flushLig();
}

/** Underline (all styles) + strikethrough rects. Same geometry as
 *  WebGL2Renderer.pushDecorations / Canvas2DRenderer.paintDecorations. */
function pushDecorations(
  deco: InstanceList,
  cell: Cell,
  x: number,
  y: number,
  ctx: RowBuildCtx,
  rect: (l: InstanceList, x: number, y: number, w: number, h: number, c: Rgba) => void,
): void {
  const { cellWidth, cellHeight } = ctx.metrics;
  const w = (cell.width === 2 ? 2 : 1) * cellWidth;
  const t = Math.max(1, Math.round(cellHeight / 16));
  const f = cell.flags;
  const fgC = cssToRgba(cellFg(cell, ctx.palette, ctx.colorOpts));

  if (f & FLAG.STRIKEOUT) {
    rect(deco, x, y + Math.round(cellHeight * 0.55) - Math.floor(t / 2), w, t, fgC);
  }
  if (!(f & ANY_UNDERLINE)) return;
  const ulC =
    cell.ulColor !== undefined
      ? cssToRgba(resolveColor(cell.ulColor, ctx.palette, true))
      : fgC;
  const uy = y + cellHeight - t - 1;
  if (f & FLAG.DOUBLE_UNDERLINE) {
    rect(deco, x, uy - t - 1, w, t, ulC);
    rect(deco, x, uy + t + 1, w, t, ulC);
  } else if (f & FLAG.DOTTED_UNDERLINE) {
    for (let dx = 0; dx < w; dx += 2 * t) rect(deco, x + dx, uy, t, t, ulC);
  } else if (f & FLAG.DASHED_UNDERLINE) {
    const dash = Math.max(2 * t, Math.round(cellWidth / 3));
    for (let dx = 0; dx < w; dx += dash * 2) rect(deco, x + dx, uy, dash, t, ulC);
  } else if (f & FLAG.UNDERCURL) {
    for (let dx = 0; dx < w; dx += t) {
      const up = Math.floor(dx / t) % 2 === 0;
      rect(deco, x + dx, uy + (up ? -1 : t), t, t, ulC);
    }
  } else {
    rect(deco, x, uy, w, t, ulC);
  }
}
