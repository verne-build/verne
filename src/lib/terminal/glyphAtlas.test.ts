import { describe, it, expect } from 'vitest';
import { glyphKey, pickRenderer, AtlasPacker } from './glyphAtlas';
import { FLAG, type Cell } from './gridProtocol';

const cell = (over: Partial<Cell> = {}): Cell => ({
  cp: 65,
  fg: 0,
  bg: 0,
  flags: 0,
  width: 1,
  ...over,
});

describe('glyphKey', () => {
  it('ignores color but distinguishes style + width + combining marks', () => {
    expect(glyphKey(cell({ fg: 123 }))).toBe(glyphKey(cell({ fg: 456 }))); // color excluded
    expect(glyphKey(cell({ flags: FLAG.BOLD }))).not.toBe(glyphKey(cell()));
    expect(glyphKey(cell({ width: 2 }))).not.toBe(glyphKey(cell()));
    expect(glyphKey(cell({ zw: [0x301] }))).not.toBe(glyphKey(cell()));
    // inverse/underline are not glyph-shaping → same key
    expect(glyphKey(cell({ flags: FLAG.INVERSE }))).toBe(glyphKey(cell()));
  });
});

describe('AtlasPacker', () => {
  it('packs variable-width entries left-to-right, then new shelves', () => {
    const p = new AtlasPacker(100, 40, 20);
    expect(p.allocate('a', 30)).toEqual({ x: 0, y: 0, isNew: true });
    expect(p.allocate('b', 30)).toEqual({ x: 30, y: 0, isNew: true });
    expect(p.allocate('c', 50)).toEqual({ x: 0, y: 20, isNew: true }); // no fit on shelf 0
    expect(p.allocate('d', 40)).toEqual({ x: 60, y: 0, isNew: true }); // back-fills shelf 0
  });

  it('returns existing entries without isNew', () => {
    const p = new AtlasPacker(100, 40, 20);
    p.allocate('a', 30);
    expect(p.allocate('a', 30)).toEqual({ x: 0, y: 0, isNew: false });
    expect(p.get('a')).toEqual({ x: 0, y: 0 });
    expect(p.get('zz')).toBeUndefined();
  });

  it('returns null when nothing fits (full or too wide)', () => {
    const p = new AtlasPacker(100, 40, 20);
    expect(p.allocate('wide', 101)).toBeNull(); // wider than the atlas
    p.allocate('a', 100);
    p.allocate('b', 100);
    expect(p.allocate('c', 10)).toBeNull(); // both shelves exhausted
  });

  it('reset clears entries and bumps generation', () => {
    const p = new AtlasPacker(100, 40, 20);
    p.allocate('a', 30);
    expect(p.generation).toBe(0);
    p.reset();
    expect(p.generation).toBe(1);
    expect(p.get('a')).toBeUndefined();
    expect(p.allocate('b', 30)).toEqual({ x: 0, y: 0, isNew: true });
  });

  it('grow preserves entries and opens new space without bumping generation', () => {
    const p = new AtlasPacker(100, 40, 20);
    p.allocate('a', 100);
    p.allocate('b', 100);
    expect(p.allocate('c', 50)).toBeNull();
    p.grow(200, 80);
    expect(p.generation).toBe(0);
    expect(p.get('a')).toEqual({ x: 0, y: 0 }); // entries keep coords
    expect(p.allocate('c', 50)).toEqual({ x: 100, y: 0, isNew: true }); // old shelf extends
    expect(p.allocate('d', 180)).toEqual({ x: 0, y: 40, isNew: true }); // new shelf in new space
  });
});

describe('pickRenderer', () => {
  it('prefers webgl2 when available', () => {
    expect(pickRenderer({ webgl2: true })).toBe('webgl2');
    expect(pickRenderer({ webgl2: false })).toBe('canvas2d');
  });
});
