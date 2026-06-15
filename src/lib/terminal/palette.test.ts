import { describe, it, expect } from 'vitest';
import {
  defaultPalette,
  ansi256,
  resolveColor,
  contrastRatio,
  parseCssColor,
  withMinContrast,
  blendLinear,
} from './palette';
import { DEFAULT_COLOR, indexedColor, rgbColor } from './gridProtocol';

describe('withMinContrast', () => {
  it('is a no-op when contrast already meets the ratio', () => {
    expect(withMinContrast('rgb(255, 255, 255)', 'rgb(0, 0, 0)', 4.5)).toBe('rgb(255, 255, 255)');
  });
  it('lifts an unreadable fg until it meets the ratio', () => {
    const lifted = withMinContrast('rgb(40, 40, 40)', 'rgb(0, 0, 0)', 4.5);
    const ratio = contrastRatio(parseCssColor(lifted), parseCssColor('rgb(0, 0, 0)'));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
  it('parses both rgb() and hex', () => {
    expect(parseCssColor('#ff0000')).toEqual([255, 0, 0]);
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
  });
});

describe('blendLinear', () => {
  it('returns the endpoints at t=1 and t=0', () => {
    expect(blendLinear('rgb(200, 200, 200)', 'rgb(0, 0, 0)', 1)).toBe('rgb(200, 200, 200)');
    expect(blendLinear('rgb(200, 200, 200)', 'rgb(0, 0, 0)', 0)).toBe('rgb(0, 0, 0)');
  });
  it('blends toward the background at partial t (gamma-correct, darker)', () => {
    const out = parseCssColor(blendLinear('rgb(255, 255, 255)', 'rgb(0, 0, 0)', 0.55));
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeLessThan(255);
  });
});

describe('resolveColor', () => {
  it('returns palette default for default color', () => {
    expect(resolveColor(DEFAULT_COLOR, defaultPalette, true)).toBe(defaultPalette.foreground);
    expect(resolveColor(DEFAULT_COLOR, defaultPalette, false)).toBe(defaultPalette.background);
  });

  it('maps the 16 base ANSI indices', () => {
    expect(resolveColor(indexedColor(1), defaultPalette, true)).toBe(defaultPalette.ansi[1]);
    expect(resolveColor(indexedColor(15), defaultPalette, true)).toBe(defaultPalette.ansi[15]);
  });

  it('maps the 6x6x6 color cube and grayscale ramp', () => {
    expect(ansi256(196, defaultPalette)).toBe('rgb(255, 0, 0)'); // cube corner
    expect(ansi256(16, defaultPalette)).toBe('rgb(0, 0, 0)');
    expect(ansi256(232, defaultPalette)).toBe('rgb(8, 8, 8)'); // first gray
  });

  it('passes rgb through', () => {
    expect(resolveColor(rgbColor(10, 20, 30), defaultPalette, true)).toBe('rgb(10, 20, 30)');
  });
});
