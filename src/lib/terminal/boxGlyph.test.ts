import { describe, it, expect } from 'vitest';
import { drawBoxGlyph, isBoxGlyph } from './boxGlyph';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
class FakeCtx {
  fillStyle = '';
  globalAlpha = 1;
  rects: Rect[] = [];
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ x, y, w, h });
  }
}

describe('boxGlyph', () => {
  it('recognizes box-drawing and block code points', () => {
    expect(isBoxGlyph(0x2502)).toBe(true); // │
    expect(isBoxGlyph(0x2588)).toBe(true); // █
    expect(isBoxGlyph('A'.codePointAt(0)!)).toBe(false);
  });

  it('vertical bar fills the full cell height so rows connect', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x2502, 0, 0, 8, 16); // cell (0,0) 8x16
    const top = Math.min(...ctx.rects.map((r) => r.y));
    const bottom = Math.max(...ctx.rects.map((r) => r.y + r.h));
    expect(top).toBe(0);
    expect(bottom).toBe(16); // reaches both edges → joins adjacent rows
  });

  it('horizontal bar fills the full cell width', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x2500, 0, 0, 8, 16);
    const leftEdge = Math.min(...ctx.rects.map((r) => r.x));
    const rightEdge = Math.max(...ctx.rects.map((r) => r.x + r.w));
    expect(leftEdge).toBe(0);
    expect(rightEdge).toBe(8);
  });

  it('full block fills the whole cell', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x2588, 2, 4, 8, 16);
    expect(ctx.rects[0]).toEqual({ x: 2, y: 4, w: 8, h: 16 });
  });

  it('recognizes Powerline + sextant code points', () => {
    expect(isBoxGlyph(0xe0b0)).toBe(true); //  right triangle
    expect(isBoxGlyph(0x1fb00)).toBe(true); // sextant
    expect(isBoxGlyph(0x1fb3b)).toBe(true); // last sextant
  });

  it('fills a solid Powerline triangle edge-to-edge', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0xe0b0, 0, 0, 8, 16);
    expect(ctx.rects.length).toBeGreaterThan(0);
    // center row reaches (near) full width; first/last rows are narrow
    const maxW = Math.max(...ctx.rects.map((r) => r.w));
    expect(maxW).toBeGreaterThanOrEqual(7);
  });

  it('draws only the top-left sub-cell for U+1FB00', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x1fb00, 0, 0, 8, 16); // pattern = bit 0 (top-left)
    expect(ctx.rects.length).toBe(1);
    expect(ctx.rects[0]).toMatchObject({ x: 0, y: 0, w: 4 });
  });

  it('strokes an arc for rounded corners when the path API is available', () => {
    const calls: string[] = [];
    const pathCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '' as CanvasLineCap,
      fillRect: () => calls.push('fillRect'),
      beginPath: () => calls.push('beginPath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      arcTo: () => calls.push('arcTo'),
      stroke: () => calls.push('stroke'),
    };
    drawBoxGlyph(pathCtx, 0x256d, 0, 0, 8, 16); // ╭
    expect(calls).toContain('arcTo');
    expect(calls).toContain('stroke');
  });

  it('falls back to sharp (fillRect) rounded corners without the path API', () => {
    const ctx = new FakeCtx(); // no path methods
    drawBoxGlyph(ctx, 0x256d, 0, 0, 8, 16);
    expect(ctx.rects.length).toBeGreaterThan(0);
  });

  it('draws dashed box lines as multiple segments', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x2504, 0, 0, 8, 16); // ┄ light triple-dash horizontal
    expect(ctx.rects.length).toBe(3);
    // all segments sit on the horizontal center band
    expect(ctx.rects.every((r) => r.y > 0 && r.y < 16)).toBe(true);
  });

  it('recognizes + strokes diagonals', () => {
    expect(isBoxGlyph(0x2571)).toBe(true);
    const calls: string[] = [];
    const pathCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '' as CanvasLineCap,
      fillRect: () => calls.push('fillRect'),
      beginPath: () => calls.push('beginPath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      stroke: () => calls.push('stroke'),
    };
    drawBoxGlyph(pathCtx, 0x2573, 0, 0, 8, 16); // ╳ both diagonals
    expect(calls.filter((c) => c === 'moveTo').length).toBe(2);
    expect(calls).toContain('stroke');
  });

  it('draws a double horizontal line as two full-width rails', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x2550, 0, 0, 8, 16); // ═
    expect(isBoxGlyph(0x2550)).toBe(true);
    // two distinct y rails, each spanning the full cell width
    const ys = [...new Set(ctx.rects.map((r) => r.y))];
    expect(ys.length).toBe(2);
    for (const yv of ys) {
      const seg = ctx.rects.filter((r) => r.y === yv);
      expect(Math.min(...seg.map((r) => r.x))).toBeLessThanOrEqual(0);
      expect(Math.max(...seg.map((r) => r.x + r.w))).toBeGreaterThanOrEqual(8);
    }
  });

  it('renders medium shade as a checkerboard (~half the pixels)', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x2592, 0, 0, 8, 16); // ▒
    // 8*16 = 128 pixels; checkerboard fills ~half as 1x1 rects
    expect(ctx.rects.length).toBeGreaterThan(50);
    expect(ctx.rects.length).toBeLessThan(80);
    expect(ctx.rects.every((r) => r.w === 1 && r.h === 1)).toBe(true);
  });

  it('recognizes geometric squares + the ⎿ tree connector', () => {
    expect(isBoxGlyph(0x25fb)).toBe(true); // ◻ white medium square (pending todo)
    expect(isBoxGlyph(0x25fc)).toBe(true); // ◼ black medium square (in-progress)
    expect(isBoxGlyph(0x25a0)).toBe(true); // ■
    expect(isBoxGlyph(0x25a1)).toBe(true); // □
    expect(isBoxGlyph(0x23bf)).toBe(true); // ⎿
  });

  it('draws a filled square as one discrete rect within the cell', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x25fc, 0, 0, 8, 16, 1, 13, 14); // ◼
    expect(ctx.rects.length).toBe(1);
    const r = ctx.rects[0];
    // A discrete symbol within the cell (vertically inset; never wider than it).
    expect(r.y).toBeGreaterThan(0);
    expect(r.y + r.h).toBeLessThan(16);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(8);
  });

  it('draws an outline square as four edges around a hollow center', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x25fb, 0, 0, 8, 16); // ◻
    expect(ctx.rects.length).toBe(4);
    // No rect covers the cell center → the box is hollow.
    const covers = (px: number, py: number) =>
      ctx.rects.some((r) => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
    expect(covers(4, 8)).toBe(false);
  });

  it('draws ⎿ to the cell bottom + foot to the right edge (no-metrics fallback)', () => {
    const ctx = new FakeCtx();
    drawBoxGlyph(ctx, 0x23bf, 0, 0, 8, 16); // ⎿ — no baseline → falls back to cell bottom
    const top = Math.min(...ctx.rects.map((r) => r.y));
    const bottom = Math.max(...ctx.rects.map((r) => r.y + r.h));
    expect(top).toBe(0);
    expect(bottom).toBe(16); // vertical spans the full cell height
    // The previously-clipped part: a horizontal segment reaching the right edge.
    const foot = ctx.rects.find((r) => r.w > r.h);
    expect(foot).toBeDefined();
    expect(foot!.x + foot!.w).toBe(8);
  });

  it('drops the ⎿ foot to the BASELINE, not the cell bottom, when metrics are given', () => {
    const ctx = new FakeCtx();
    const baseline = 13; // cell is 16 tall; 13..16 is the descender + leading gap
    drawBoxGlyph(ctx, 0x23bf, 0, 0, 8, 16, 1, baseline, 14);
    const top = Math.min(...ctx.rects.map((r) => r.y));
    const bottom = Math.max(...ctx.rects.map((r) => r.y + r.h));
    expect(top).toBe(0); // vertical still starts at the cell top (connects up to │)
    expect(bottom).toBe(baseline); // ...but stops at the baseline, not 16
    const foot = ctx.rects.find((r) => r.w > r.h);
    expect(foot).toBeDefined();
    expect(foot!.x + foot!.w).toBe(8); // foot still reaches the right edge
    expect(foot!.y + foot!.h).toBe(baseline); // foot sits ON the baseline
  });

  it('sizes a todo-marker square to the text cap band, centered on it, when metrics are given', () => {
    const ctx = new FakeCtx();
    const baseline = 13;
    const fontSize = 14;
    drawBoxGlyph(ctx, 0x25fc, 0, 0, 8, 16, 1, baseline, fontSize); // ◼ in-progress
    expect(ctx.rects.length).toBe(1);
    const r = ctx.rects[0];
    // Much bigger than the old min(w,h)*0.62 ≈ 5px dot — fills ~the cell width.
    expect(r.w).toBeGreaterThan(6);
    expect(r.w).toBeCloseTo(r.h, 5); // square
    // Centered on the cap band (baseline up to the cap top), so it sits over the
    // text rather than low in the line: its center is above the baseline and it
    // doesn't spill past it.
    const cy = r.y + r.h / 2;
    expect(cy).toBeLessThan(baseline);
    expect(r.y + r.h).toBeLessThanOrEqual(baseline + 0.5);
  });

  it('returns false for non-box glyphs', () => {
    const ctx = new FakeCtx();
    expect(drawBoxGlyph(ctx, 'A'.codePointAt(0)!, 0, 0, 8, 16)).toBe(false);
    expect(ctx.rects.length).toBe(0);
  });
});
