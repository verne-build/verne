import { describe, it, expect } from 'vitest';
import { deviceAlign, cellWidthFor, cellHeightFor, gridSizeFor } from './metrics';

describe('terminal cell metrics device alignment', () => {
  // The bug: a fractional cellWidth makes the renderer's per-column snap()
  // produce quads of varying device width, so glyphs change size across
  // columns. The invariant that prevents it: dim * dpr is a whole number, so
  // col * dim * dpr is integer for every column.
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    it(`cellWidth lands on a whole device pixel (dpr=${dpr})`, () => {
      // A typically-fractional monospace advance (e.g. SF Mono @13px).
      const w = cellWidthFor(7.8125, dpr);
      expect(isWhole(w * dpr)).toBe(true);
    });

    it(`every column boundary is integer device px so snap is identity (dpr=${dpr})`, () => {
      const w = cellWidthFor(7.8125, dpr);
      for (let col = 0; col <= 200; col++) {
        const devicePx = col * w * dpr;
        expect(isWhole(devicePx)).toBe(true);
        // snap() == round(v*dpr)/dpr applied to the CSS position is a no-op.
        const cssPos = col * w;
        expect(Math.round(cssPos * dpr) / dpr).toBeCloseTo(cssPos, 10);
      }
    });

    it(`cellHeight lands on a whole device pixel (dpr=${dpr})`, () => {
      const h = cellHeightFor(13, 1.2, dpr);
      expect(isWhole(h * dpr)).toBe(true);
    });
  }

  it('never collapses below one device pixel', () => {
    expect(deviceAlign(0.1, 2)).toBeGreaterThanOrEqual(0.5); // 1 device px at dpr=2
    expect(deviceAlign(0, 1)).toBe(1);
  });

  it('aligns height to the device grid (dpr=2)', () => {
    // max(13+2, 13*1.2)=15.6 → round(15.6*2)=31 device px → 15.5 CSS px.
    expect(cellHeightFor(13, 1.2, 2)).toBeCloseTo(31 / 2, 10);
  });
});

function isWhole(n: number): boolean {
  return Math.abs(n - Math.round(n)) < 1e-9;
}

describe('terminal grid sizing', () => {
  const metrics = { cellWidth: 8, cellHeight: 16 };

  it('computes whole cells inside the padded container', () => {
    expect(gridSizeFor(820, 500, 10, metrics)).toEqual({ cols: 100, rows: 30 });
  });

  it('does not turn a hidden container into a 1x1 terminal', () => {
    expect(gridSizeFor(0, 0, 10, metrics)).toBeNull();
  });

  it('waits when transient layout cannot fit one cell', () => {
    expect(gridSizeFor(27, 35, 10, metrics)).toBeNull();
  });
});
