import { describe, it, expect } from 'vitest';
import { orderSelection, flattenSelection, wordRange, type LineMap } from './selection';
import { detectLinks, linkAt } from './links';
import { rowToText, gridToText, announcement } from './a11y';
import { sliderGeometry, positionToScrollOffset } from './scrollbar';
import type { Cell } from './gridProtocol';

const cell = (ch: string, width = 1): Cell => ({
  cp: ch.codePointAt(0)!,
  fg: 0,
  bg: 0,
  flags: 0,
  width,
});
const cells = (s: string): Cell[] => [...s].map((c) => cell(c));

describe('selection', () => {
  const lines = ['hello world', 'second line', 'third'];
  // Identity maps — pure-ASCII lines have col == string index.
  const getLine = (l: number): LineMap => {
    const text = lines[l];
    const ident = Array.from({ length: text.length + 1 }, (_, i) => i);
    return { text, colToIdx: ident, idxToCol: ident };
  };

  it('orders positions', () => {
    expect(orderSelection({ line: 2, col: 1 }, { line: 1, col: 5 })).toEqual({
      start: { line: 1, col: 5 },
      end: { line: 2, col: 1 },
    });
  });

  it('flattens a single-line selection', () => {
    const sel = orderSelection({ line: 0, col: 0 }, { line: 0, col: 5 });
    expect(flattenSelection(sel, getLine)).toBe('hello');
  });

  it('flattens a multi-line selection with newlines', () => {
    const sel = orderSelection({ line: 0, col: 6 }, { line: 2, col: 5 });
    expect(flattenSelection(sel, getLine)).toBe('world\nsecond line\nthird');
  });

  it('finds word boundaries for double-click', () => {
    expect(wordRange('hello world', 7)).toEqual({ start: 6, end: 11 });
    expect(wordRange('a b', 1)).toEqual({ start: 1, end: 1 }); // on a space
  });

  // wrap-aware flatten tests
  it('flattenSelection: all-wrapped 3-line → no newlines', () => {
    // lines 0 and 1 both wrap into next → 0-1 and 1-2 joined with ''
    const isWrapped = (l: number) => l === 0 || l === 1;
    const sel = orderSelection({ line: 0, col: 0 }, { line: 2, col: 5 });
    expect(flattenSelection(sel, getLine, isWrapped)).toBe('hello worldsecond linethird');
  });

  it('flattenSelection: first pair wrapped only → newline only before line 2', () => {
    // line 0 wraps into line 1 (no newline), line 1 does NOT wrap into line 2 (newline)
    const isWrapped = (l: number) => l === 0;
    const sel = orderSelection({ line: 0, col: 0 }, { line: 2, col: 5 });
    expect(flattenSelection(sel, getLine, isWrapped)).toBe('hello worldsecond line\nthird');
  });

  it('flattenSelection: no wrapping → newlines as before (2-arg backward-compat)', () => {
    const sel = orderSelection({ line: 0, col: 6 }, { line: 2, col: 5 });
    // existing 2-arg call — must still work unchanged
    expect(flattenSelection(sel, getLine)).toBe('world\nsecond line\nthird');
  });

  it('flattenSelection: single-line unchanged regardless of isWrapped', () => {
    const isWrapped = (_l: number) => true;
    const sel = orderSelection({ line: 0, col: 0 }, { line: 0, col: 5 });
    expect(flattenSelection(sel, getLine, isWrapped)).toBe('hello');
  });
});

describe('links', () => {
  it('detects urls and paths, url wins on overlap', () => {
    const text = 'see https://example.com/x and /usr/local/bin here';
    const m = detectLinks(text);
    const url = m.find((x) => x.kind === 'url')!;
    expect(url.value).toBe('https://example.com/x');
    const path = m.find((x) => x.kind === 'path')!;
    expect(path.value).toBe('/usr/local/bin');
    // the "/x" path inside the URL must not be reported separately
    expect(m.filter((x) => x.kind === 'path').length).toBe(1);
  });

  it('linkAt finds the link covering a column', () => {
    const text = 'go /a/b now';
    const m = detectLinks(text);
    expect(linkAt(m, 4)?.value).toBe('/a/b');
    expect(linkAt(m, 0)).toBeUndefined();
  });
});

describe('a11y', () => {
  it('projects rows to trimmed text, skipping spacers', () => {
    const row = [cell('世', 2), { cp: 0, fg: 0, bg: 0, flags: 0, width: 0 }, cell('x'), cell(' ')];
    expect(rowToText(row)).toBe('世x');
  });

  it('projects the whole grid', () => {
    expect(gridToText([cells('ab  '), cells('cd  ')])).toEqual(['ab', 'cd']);
  });

  it('caps announcement length to avoid SR flooding', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    expect(announcement(big, 100).length).toBeLessThanOrEqual(100);
  });
});

describe('scrollbar geometry', () => {
  it('hides when content fits', () => {
    expect(sliderGeometry(24, 24, 100, 0).visible).toBe(false);
  });

  it('sizes the slider to the visible fraction and sits at bottom when following', () => {
    const g = sliderGeometry(10, 100, 200, 0);
    expect(g.visible).toBe(true);
    expect(g.size).toBeCloseTo(20, 5); // 200 * 10/100
    expect(g.pos).toBeCloseTo(180, 5); // bottom: track - size
  });

  it('sits at top when fully scrolled up', () => {
    const g = sliderGeometry(10, 100, 200, 90); // maxScroll = 90
    expect(g.pos).toBeCloseTo(0, 5);
  });

  it('round-trips position → offset', () => {
    const off = positionToScrollOffset(0, 20, 200, 10, 100);
    expect(off).toBe(90); // top → max scroll
    expect(positionToScrollOffset(180, 20, 200, 10, 100)).toBe(0); // bottom → following
  });
});
