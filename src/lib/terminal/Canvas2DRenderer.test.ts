import { describe, it, expect } from 'vitest';
import { Canvas2DRenderer, type Ctx2DLike } from './Canvas2DRenderer';
import { GridStore } from './GridStore';
import { defaultPalette } from './palette';
import { indexedColor, rgbColor, type Cell, type SyncFrame, type WireModes } from './gridProtocol';
import type { FontMetrics } from './renderer';

const METRICS: FontMetrics = {
  cellWidth: 8,
  cellHeight: 16,
  baseline: 12,
  fontFamily: 'mono',
  fontSize: 14,
};

const MODES: WireModes = {
  mouseReporting: false,
  altScreen: false,
  appCursor: false,
  bracketedPaste: false,
};

interface RectCall {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
}
interface TextCall {
  text: string;
  x: number;
  y: number;
  style: string;
}

class FakeCtx implements Ctx2DLike {
  fillStyle = '';
  font = '';
  textBaseline = '';
  globalAlpha = 1;
  rects: RectCall[] = [];
  texts: (TextCall & { alpha: number; scaleX: number })[] = [];
  scaleCalls: { x: number; y: number }[] = [];
  /** Per-char advance measureText reports. Default == cellWidth so runs need no
   *  scaling; a test lowers it to model the device-rounding gap that drifts. */
  advance = METRICS.cellWidth;
  // Minimal axis-aligned CTM: deviceX = a*userX + e (translate/scale only), so a
  // fillText drawn under save/translate/scale records its real device position.
  private a = 1;
  private e = 0;
  private stack: { a: number; e: number }[] = [];
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ x, y, w, h, style: this.fillStyle });
  }
  fillText(text: string, x: number, y: number) {
    this.texts.push({
      text,
      x: this.a * x + this.e,
      y,
      style: this.fillStyle,
      alpha: this.globalAlpha,
      scaleX: this.a,
    });
  }
  clearRect() {}
  measureText(text: string) {
    return { width: text.length * this.advance };
  }
  save() {
    this.stack.push({ a: this.a, e: this.e });
  }
  restore() {
    const s = this.stack.pop();
    if (s) {
      this.a = s.a;
      this.e = s.e;
    }
  }
  translate(x: number, _y: number) {
    this.e = this.a * x + this.e;
  }
  scale(x: number, _y: number) {
    this.a *= x;
    this.scaleCalls.push({ x, y: _y });
  }
}

const cell = (ch: string, over: Partial<Cell> = {}): Cell => ({
  cp: ch.codePointAt(0)!,
  fg: 0,
  bg: 0,
  flags: 0,
  width: 1,
  ...over,
});

function storeWith(cells: Cell[], over: Partial<SyncFrame> = {}): GridStore {
  const s = new GridStore();
  s.applySync({
    type: 'sync',
    rev: 1,
    cols: 3,
    rows: 1,
    cursor: [0, 0],
    altScreen: false,
    modes: MODES,
    totalLines: 1,
    runs: [{ line: 0, startCol: 0, cells, wrapped: false }],
    ...over,
  });
  return s;
}

describe('Canvas2DRenderer', () => {
  it('paints glyphs at cell positions and clears dirty rows', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    const store = storeWith([cell('H', { fg: rgbColor(255, 0, 0) }), cell('i')]);
    r.paint(store);

    const h = ctx.texts.find((t) => t.text === 'H')!;
    expect(h.x).toBe(0);
    expect(h.y).toBe(12); // baseline
    expect(h.style).toBe('rgb(255, 0, 0)');
    const i = ctx.texts.find((t) => t.text === 'i')!;
    expect(i.x).toBe(8); // second column
    expect(store.dirtyRows.size).toBe(0); // cleared after paint
  });

  it('does not draw a glyph for a blank space (background only)', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    r.paint(storeWith([cell(' '), cell('x')]));
    expect(ctx.texts.map((t) => t.text)).toEqual(['x']);
    expect(ctx.rects.length).toBeGreaterThanOrEqual(1); // coalesced background
  });

  it('swaps fg/bg for inverse cells', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    // inverse cell with rgb fg: background should be drawn in that fg color.
    const inv = cell('A', { fg: rgbColor(1, 2, 3), flags: 1 << 4 /* INVERSE */ });
    r.paint(storeWith([inv]));
    const bg = ctx.rects[0];
    expect(bg.style).toBe('rgb(1, 2, 3)');
  });

  it('spans a wide char over two columns and skips the spacer', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    // Distinct bg so the wide char forms its own background run (coalescing
    // merges adjacent same-bg cells).
    r.paint(storeWith([cell('世', { width: 2, bg: rgbColor(9, 9, 9) }), cell('x')]));
    const wide = ctx.texts.find((t) => t.text === '世')!;
    expect(wide.x).toBe(0);
    const bgWide = ctx.rects.find((rc) => rc.x === 0)!;
    expect(bgWide.w).toBe(16); // two cells wide
    const x = ctx.texts.find((t) => t.text === 'x')!;
    expect(x.x).toBe(16); // after the wide char's two columns
  });

  it('draws contiguous same-style cells as one run when ligatures are on', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS, ligatures: true });
    r.cursorVisible = false;
    r.paint(storeWith([cell('a'), cell('='), cell('>'), cell('b')], { cols: 10 }));
    // one fillText for the whole run, at the run start, so the font can ligate.
    const run = ctx.texts.find((t) => t.text === 'a=>b');
    expect(run).toBeDefined();
    expect(run!.x).toBe(0);
    expect(ctx.texts.length).toBe(1);
  });

  it('maps a ligature run onto its cell-grid span so glyphs do not drift off the cursor', () => {
    const ctx = new FakeCtx();
    ctx.advance = 7; // raw font advance < device-rounded cellWidth (8): the drift source
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS, ligatures: true });
    r.cursorVisible = false;
    // The wide char breaks the run, so "abc" starts at col 2 (exercises translate too).
    r.paint(storeWith([cell('世', { width: 2 }), cell('a'), cell('b'), cell('c')], { cols: 6 }));
    const run = ctx.texts.find((t) => t.text === 'abc')!;
    const natural = 3 * 7; // measureText('abc')
    const gridSpan = 3 * METRICS.cellWidth; // 24
    // Left edge lands on col 2's grid line — not 2*7=14 from the raw advance.
    expect(run.x).toBeCloseTo(2 * METRICS.cellWidth); // 16
    // Scaled so the natural width fills exactly the 3-cell span (right edge on grid).
    expect(run.scaleX).toBeCloseTo(gridSpan / natural); // 24/21
    expect(run.scaleX * natural).toBeCloseTo(gridSpan);
  });

  it('draws per-cell (no ligatures) by default', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS }); // ligatures off
    r.cursorVisible = false;
    r.paint(storeWith([cell('a'), cell('='), cell('>')]));
    expect(ctx.texts.map((t) => t.text)).toEqual(['a', '=', '>']);
  });

  it('dims faint (DIM) glyphs by blending toward the background', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    r.paint(storeWith([cell('d', { flags: 1 << 1 /* DIM */ }), cell('n')]));
    const dim = ctx.texts.find((t) => t.text === 'd')!;
    const normal = ctx.texts.find((t) => t.text === 'n')!;
    // dim glyph color differs from the normal foreground (blended, full alpha)
    expect(dim.style).not.toBe(normal.style);
    expect(dim.alpha).toBe(1);
  });

  it('draws strikethrough and underline decorations', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    const before = ctx.rects.length;
    r.paint(storeWith([cell('s', { flags: (1 << 5) | (1 << 3) /* STRIKEOUT|UNDERLINE */ })]));
    // background run + strikethrough rect + underline rect
    expect(ctx.rects.length).toBeGreaterThan(before + 1);
  });

  it('uses the explicit underline color when present', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    r.paint(
      storeWith([cell('u', { flags: 1 << 3 /* UNDERLINE */, ulColor: rgbColor(7, 8, 9) })]),
    );
    expect(ctx.rects.some((rc) => rc.style === 'rgb(7, 8, 9)')).toBe(true);
  });

  it('maps bold ANSI 0-7 to bright 8-15 when boldIsBright is on', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS, boldIsBright: true });
    r.cursorVisible = false;
    // indexed red (1) + BOLD → bright red (ansi[9]).
    r.paint(storeWith([cell('x', { fg: indexedColor(1), flags: 1 << 0 /* BOLD */ })]));
    const g = ctx.texts.find((t) => t.text === 'x')!;
    expect(g.style).toBe(defaultPalette.ansi[9]);
  });

  it('draws a block cursor when visible', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = true;
    r.paint(storeWith([cell('a'), cell('b')], { cursor: [0, 1] }));
    const cursorRect = ctx.rects.find((rc) => rc.style === defaultPalette.cursor && rc.x === 8);
    expect(cursorRect).toBeDefined();
    // block cursor fills the whole cell height
    expect(cursorRect!.h).toBe(METRICS.cellHeight);
  });

  it('draws a beam cursor as a thin vertical bar', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = true;
    r.paint(storeWith([cell('a'), cell('b')], { cursor: [0, 1], cursorShape: 'beam' }));
    const bar = ctx.rects.find((rc) => rc.style === defaultPalette.cursor && rc.x === 8)!;
    expect(bar.h).toBe(METRICS.cellHeight);
    expect(bar.w).toBeLessThan(METRICS.cellWidth); // thin
  });

  it('draws a hollow cursor when unfocused', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = true;
    r.setFocused(false);
    r.paint(storeWith([cell('a'), cell('b')], { cursor: [0, 1] }));
    // outline = 4 border rects in the cursor color (not one full-cell fill)
    const cur = ctx.rects.filter((rc) => rc.style === defaultPalette.cursor && rc.x >= 8 - 2);
    expect(cur.length).toBeGreaterThanOrEqual(4);
  });

  // A 3-row screen over 2 rows of scrollback; cursor on the middle live row.
  const scrollableStore = (cursorRow: number): GridStore => {
    const s = new GridStore();
    s.applySync({
      type: 'sync',
      rev: 1,
      cols: 3,
      rows: 3,
      cursor: [cursorRow, 0],
      altScreen: false,
      modes: MODES,
      totalLines: 5, // 2 history lines above the 3 live rows
      runs: [
        { line: 0, startCol: 0, cells: [cell('a')] , wrapped: false},
        { line: 1, startCol: 0, cells: [cell('b')] , wrapped: false},
        { line: 2, startCol: 0, cells: [cell('c')] , wrapped: false},
      ],
    });
    return s;
  };

  const blockCursor = (ctx: FakeCtx) =>
    ctx.rects.find((rc) => rc.style === defaultPalette.cursor && rc.h === METRICS.cellHeight);

  it('shifts the cursor with its line while scrolled within the sticky threshold', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.resize(3, 3, 1);
    r.cursorVisible = true;
    const s = scrollableStore(1);
    s.setScrollOffset(1); // still atBottom(), but the window shifted down one row
    expect(s.atBottom()).toBe(true);
    r.paint(s);
    // Cursor must follow its line to render row cursor[0] + scrollOffset = 2,
    // not stay pinned at its old screen row 1.
    expect(blockCursor(ctx)!.y).toBe(2 * METRICS.cellHeight);
  });

  it('paints search matches: dim for all, current color for the active one', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.cursorVisible = false;
    const store = storeWith([cell('a'), cell('b'), cell('c')]); // 1 row, abs line 0
    r.setSearchMatches([{ line: 0, col: 0, len: 1 }, { line: 0, col: 2, len: 1 }], 1);
    store.markAllDirty();
    r.paint(store);
    const styles = ctx.rects.map((rc) => rc.style);
    expect(styles).toContain(defaultPalette.searchMatch); // match index 0 (dim)
    expect(styles).toContain(defaultPalette.searchMatchCurrent); // index 1 (current)
  });

  it('hides the cursor once its line scrolls off the bottom of the viewport', () => {
    const ctx = new FakeCtx();
    const r = new Canvas2DRenderer(ctx, { metrics: METRICS });
    r.resize(3, 3, 1);
    r.cursorVisible = true;
    const s = scrollableStore(2); // cursor on the last live row
    s.setScrollOffset(1); // its line is now pushed to render row 3 (off-screen)
    expect(s.atBottom()).toBe(true);
    r.paint(s);
    expect(blockCursor(ctx)).toBeUndefined();
  });
});
