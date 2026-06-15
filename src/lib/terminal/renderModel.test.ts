import { describe, it, expect } from 'vitest';
import { InstanceList, RECT_F, GLYPH_F, cssToRgba, buildRow, makeRowModel, type RowBuildCtx } from './renderModel';
import { FLAG, rgbColor, type Cell } from './gridProtocol';
import { defaultPalette } from './palette';

describe('cssToRgba', () => {
  it('parses rgb() and #hex; falls back to white', () => {
    expect(cssToRgba('rgb(255, 0, 128)')).toEqual([1, 0, 128 / 255, 1]);
    expect(cssToRgba('#ff0080')).toEqual([1, 0, 128 / 255, 1]);
    expect(cssToRgba('garbage')).toEqual([1, 1, 1, 1]);
  });
});

describe('InstanceList', () => {
  it('pushes rects and exposes a sized view', () => {
    const l = new InstanceList(RECT_F);
    l.pushRect(1, 2, 3, 4, [0.1, 0.2, 0.3, 1]);
    expect(l.count).toBe(1);
    expect([...l.view()]).toEqual([1, 2, 3, 4, new Float32Array([0.1])[0], new Float32Array([0.2])[0], new Float32Array([0.3])[0], 1]);
  });

  it('pushes glyphs with uv rects', () => {
    const l = new InstanceList(GLYPH_F);
    l.pushGlyph(5, 6, 7, 8, 0.1, 0.2, 0.3, 0.4, [1, 1, 1, 1]);
    expect(l.count).toBe(1);
    expect(l.view().length).toBe(GLYPH_F);
  });

  it('grows past initial capacity and resets O(1)', () => {
    const l = new InstanceList(RECT_F, 2);
    for (let i = 0; i < 100; i++) l.pushRect(i, 0, 1, 1, [0, 0, 0, 1]);
    expect(l.count).toBe(100);
    l.reset();
    expect(l.count).toBe(0);
    expect(l.view().length).toBe(0);
  });

  it('appends another list of the same stride', () => {
    const a = new InstanceList(RECT_F, 2);
    const b = new InstanceList(RECT_F, 2);
    a.pushRect(1, 1, 1, 1, [0, 0, 0, 1]);
    for (let i = 0; i < 10; i++) b.pushRect(i, 2, 2, 2, [1, 1, 1, 1]);
    a.append(b);
    expect(a.count).toBe(11);
    expect(a.view()[RECT_F]).toBe(0); // first appended rect x
  });
});

const cell = (ch: string, over: Partial<Cell> = {}): Cell => ({
  cp: ch.codePointAt(0)!, fg: 0, bg: 0, flags: 0, width: 1, ...over,
});

function ctx(over: Partial<RowBuildCtx> = {}): RowBuildCtx {
  return {
    y: 0,
    cols: 20,
    metrics: { cellWidth: 10, cellHeight: 20, baseline: 15, fontFamily: 'mono', fontSize: 14 },
    dpr: 1,
    palette: defaultPalette,
    colorOpts: { boldIsBright: false, minContrast: 1 },
    ligatures: false,
    atlasW: 640, atlasH: 640,
    runAtlasW: 2048, runAtlasH: 256,
    ensureGlyph: () => ({ x: 0, y: 0, w: 9 }),
    ensureRun: () => ({ x: 0, y: 0, w: 50, h: 20 }),
    isEmoji: () => false,
    ...over,
  };
}

describe('buildRow', () => {
  it('coalesces same-bg runs and skips the default background', () => {
    const m = makeRowModel();
    const red = rgbColor(255, 0, 0);
    buildRow(
      [cell('a', { bg: red }), cell('b', { bg: red }), cell('c'), cell('d'), cell('e', { bg: red })],
      ctx(), m,
    );
    expect(m.bg.count).toBe(2);
    const v = m.bg.view();
    expect([v[0], v[2]]).toEqual([0, 20]); // run 1: x=0 w=2 cells
    expect([v[8], v[10]]).toEqual([40, 10]); // run 2: x=40 w=1 cell
  });

  it('emits glyphs only for non-blank cells (line-length trimming)', () => {
    const m = makeRowModel();
    const cells = [cell('h'), cell('i'), ...Array.from({ length: 18 }, () => cell(' '))];
    buildRow(cells, ctx(), m);
    expect(m.fg.count).toBe(2);
  });

  it('spans wide chars over 2 cells and skips spacers', () => {
    const m = makeRowModel();
    buildRow([cell('世', { width: 2 }), { ...cell(' '), width: 0 }, cell('x')], ctx(), m);
    expect(m.fg.count).toBe(2);
    const v = m.fg.view();
    expect(v[2]).toBe(20); // 世 quad width = 2 cells
    expect(v[12 + 0]).toBe(20); // x at col 2
  });

  it('routes emoji to the emoji list', () => {
    const m = makeRowModel();
    buildRow([cell('😀', { width: 2 })], ctx({ isEmoji: () => true }), m);
    expect(m.emoji.count).toBe(1);
    expect(m.fg.count).toBe(0);
  });

  it('width-1 emoji overhangs: quad uses the glyph natural width, not the 1 cell', () => {
    const m = makeRowModel();
    // ensureGlyph reports a glyph wider than 1 cell (cellWidth 10) — natural 18.
    buildRow(
      [cell('⚠', { zw: [0xfe0f] })],
      ctx({ isEmoji: () => true, ensureGlyph: () => ({ x: 0, y: 0, w: 18 }) }),
      m,
    );
    expect(m.emoji.count).toBe(1);
    expect(m.emoji.view()[2]).toBe(18); // overhang width, not clipped to cellWidth 10
  });

  it('width-2 emoji keeps its 2-cell width (no overhang)', () => {
    const m = makeRowModel();
    buildRow(
      [cell('😀', { width: 2 })],
      ctx({ isEmoji: () => true, ensureGlyph: () => ({ x: 0, y: 0, w: 999 }) }),
      m,
    );
    expect(m.emoji.view()[2]).toBe(20); // 2 cells; the reported width is ignored
  });

  it('non-emoji width-1 glyph keeps its exact 1-cell width', () => {
    const m = makeRowModel();
    buildRow([cell('a')], ctx({ ensureGlyph: () => ({ x: 0, y: 0, w: 999 }) }), m);
    expect(m.fg.view()[2]).toBe(10); // 1 cell; overhang never applies to text
  });

  it('emits underline + strikeout rects into deco', () => {
    const m = makeRowModel();
    buildRow([cell('u', { flags: FLAG.UNDERLINE | FLAG.STRIKEOUT })], ctx(), m);
    expect(m.deco.count).toBe(2);
  });

  it('accumulates a ligature run and falls back per-glyph when the run atlas is full', () => {
    const m = makeRowModel();
    const cells = [...'=>'].map((c) => cell(c));
    buildRow(cells, ctx({ ligatures: true }), m);
    expect(m.run.count).toBe(1);
    expect(m.fg.count).toBe(0);

    const m2 = makeRowModel();
    buildRow(cells, ctx({ ligatures: true, ensureRun: () => null }), m2);
    expect(m2.run.count).toBe(0);
    expect(m2.fg.count).toBe(2);
  });

  it('draws box glyphs as procedural rects in box', () => {
    const m = makeRowModel();
    buildRow([cell('█')], ctx(), m); // U+2588 full block — fillRect path
    expect(m.box.count).toBeGreaterThan(0);
    expect(m.fg.count).toBe(0);
  });

  it('hidden cells draw background but no glyph', () => {
    const m = makeRowModel();
    const red = rgbColor(255, 0, 0);
    buildRow([cell('s', { flags: FLAG.HIDDEN, bg: red })], ctx(), m);
    expect(m.bg.count).toBe(1);
    expect(m.fg.count).toBe(0);
  });
});
