import { describe, it, expect } from 'vitest';
import { cellBg, cellFg, DIM_ALPHA } from './cellColor';
import { defaultPalette } from './palette';
import { blendSrgb, resolveColor } from './palette';
import { FLAG, indexedColor, rgbColor, DEFAULT_COLOR, type Cell } from './gridProtocol';

const base = (over: Partial<Cell> = {}): Cell => ({
  cp: 0x41,
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  flags: 0,
  width: 1,
  ...over,
});

const opts = { boldIsBright: false, minContrast: 1 };

describe('cellFg / cellBg', () => {
  it('resolves default fg/bg from the palette', () => {
    const c = base();
    expect(cellFg(c, defaultPalette, opts)).toBe(defaultPalette.foreground);
    expect(cellBg(c, defaultPalette)).toBe(defaultPalette.background);
  });

  it('swaps fg/bg under INVERSE', () => {
    const c = base({ fg: rgbColor(10, 20, 30), bg: rgbColor(200, 200, 200), flags: FLAG.INVERSE });
    expect(cellFg(c, defaultPalette, opts)).toBe('rgb(200, 200, 200)');
    expect(cellBg(c, defaultPalette)).toBe('rgb(10, 20, 30)');
  });

  it('promotes bold ANSI 0-7 to bright 8-15 when boldIsBright', () => {
    const c = base({ fg: indexedColor(1), flags: FLAG.BOLD }); // red → bright red
    expect(cellFg(c, defaultPalette, { boldIsBright: true, minContrast: 1 })).toBe(
      defaultPalette.ansi[9],
    );
    // off → stays normal red
    expect(cellFg(c, defaultPalette, opts)).toBe(defaultPalette.ansi[1]);
  });

  it('blends DIM toward bg in sRGB', () => {
    const c = base({ fg: rgbColor(255, 255, 255), bg: rgbColor(0, 0, 0), flags: FLAG.DIM });
    const expected = blendSrgb(
      resolveColor(rgbColor(255, 255, 255), defaultPalette, true),
      resolveColor(rgbColor(0, 0, 0), defaultPalette, false),
      DIM_ALPHA,
    );
    expect(cellFg(c, defaultPalette, opts)).toBe(expected);
  });
});
