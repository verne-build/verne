// Synthetic frame generators for renderer benchmarks + pixel goldens. Frames
// are DECODED (post-wire) shapes fed straight into GridStore — no daemon, no
// WS, no PTY. Deterministic: seeded LCG, no Date/random.
import {
  DEFAULT_COLOR,
  FLAG,
  indexedColor,
  rgbColor,
  type Cell,
  type DeltaFrame,
  type RowRun,
  type SyncFrame,
  type WireModes,
} from '../../src/lib/terminal/gridProtocol';

export const MODES: WireModes = {
  mouseReporting: false,
  altScreen: false,
  appCursor: false,
  bracketedPaste: false,
};

export const cell = (ch: string, over: Partial<Cell> = {}): Cell => ({
  cp: ch.codePointAt(0)!,
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  flags: 0,
  width: 1,
  ...over,
});

/** Deterministic LCG so every run produces identical frames. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function syncFrame(cols: number, rows: number, runs: RowRun[] = []): SyncFrame {
  return {
    type: 'sync',
    rev: 1,
    cols,
    rows,
    cursor: [rows - 1, 0],
    altScreen: false,
    modes: MODES,
    totalLines: rows,
    runs,
  };
}

export function deltaFrame(rev: number, totalLines: number, runs: RowRun[]): DeltaFrame {
  return { type: 'delta', rev, cursor: [0, 0], modes: MODES, totalLines, runs };
}

const WORDS = ['build', 'cargo', 'vite', 'paint', 'frame', 'atlas', 'glyph', 'delta'];

/** Full-screen text rewrite each frame — the `yes`-flood / TUI-redraw shape. */
export function floodFrames(cols: number, rows: number, n: number): DeltaFrame[] {
  const rnd = lcg(1);
  const out: DeltaFrame[] = [];
  for (let f = 0; f < n; f++) {
    const runs: RowRun[] = [];
    for (let r = 0; r < rows; r++) {
      const text = `${WORDS[(f + r) % WORDS.length]} ${f} line ${r} `.repeat(8).slice(0, cols);
      runs.push({ line: r, startCol: 0, cells: [...text].map((c) => cell(c)), wrapped: false });
    }
    out.push(deltaFrame(2 + f, rows + f, runs));
    void rnd;
  }
  return out;
}

/** One-row change per frame — shell typing / spinner shape. */
export function sparseFrames(cols: number, rows: number, n: number): DeltaFrame[] {
  const out: DeltaFrame[] = [];
  for (let f = 0; f < n; f++) {
    const text = `sparse ${f}`.padEnd(Math.min(cols, 40));
    out.push(
      deltaFrame(2 + f, rows, [
        { line: f % rows, startCol: 0, cells: [...text].map((c) => cell(c)), wrapped: false },
      ]),
    );
  }
  return out;
}

/** Full screen of distinct truecolor fg+bg — gradient / image-in-terminal shape. */
export function truecolorFrames(cols: number, rows: number, n: number): DeltaFrame[] {
  const out: DeltaFrame[] = [];
  for (let f = 0; f < n; f++) {
    const runs: RowRun[] = [];
    for (let r = 0; r < rows; r++) {
      const cells: Cell[] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(
          cell('▀', {
            fg: rgbColor((c * 5 + f) & 0xff, (r * 9) & 0xff, (c + r) & 0xff),
            bg: rgbColor((r * 7) & 0xff, (c * 3 + f) & 0xff, (r + f) & 0xff),
          }),
        );
      }
      runs.push({ line: r, startCol: 0, cells, wrapped: false });
    }
    out.push(deltaFrame(2 + f, rows + f, runs));
  }
  return out;
}

/** Many distinct codepoints per frame — atlas-pressure shape (CJK sweep). */
export function uniqueGlyphFrames(cols: number, rows: number, n: number): DeltaFrame[] {
  const out: DeltaFrame[] = [];
  let cp = 0x4e00; // CJK unified start: thousands of distinct glyphs
  for (let f = 0; f < n; f++) {
    const runs: RowRun[] = [];
    for (let r = 0; r < rows; r++) {
      const cells: Cell[] = [];
      for (let c = 0; c + 1 < cols; c += 2) {
        cells.push({ cp: cp++, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: FLAG.WIDE, width: 2 });
        if (cp > 0x9fff) cp = 0x4e00;
      }
      runs.push({ line: r, startCol: 0, cells, wrapped: false });
    }
    out.push(deltaFrame(2 + f, rows + f, runs));
  }
  return out;
}

/** Static screen + 1000 search-match highlights across the viewport. */
export function searchHighlights(rows: number, count: number) {
  const rnd = lcg(7);
  return Array.from({ length: count }, (_, i) => ({
    line: i % rows,
    col: Math.floor(rnd() * 60),
    len: 3 + (i % 5),
  }));
}

/** Fixed style-matrix screen for pixel goldens: every attribute the renderer
 *  draws, plus CJK/emoji/box-drawing rows. */
export function stylesFixture(cols: number, rows: number): SyncFrame {
  const row = (line: number, cells: Cell[]): RowRun => ({ line, startCol: 0, cells, wrapped: false });
  const text = (s: string, over: Partial<Cell> = {}) => [...s].map((c) => cell(c, over));
  const runs: RowRun[] = [
    row(0, text('plain default text 0123456789')),
    row(1, text('bold text', { flags: FLAG.BOLD })),
    row(2, text('italic text', { flags: FLAG.ITALIC })),
    row(3, text('bold italic', { flags: FLAG.BOLD | FLAG.ITALIC })),
    row(4, text('dim text', { flags: FLAG.DIM })),
    row(5, text('inverse text', { flags: FLAG.INVERSE })),
    row(6, text('underline', { flags: FLAG.UNDERLINE })),
    row(7, text('double underline', { flags: FLAG.DOUBLE_UNDERLINE })),
    row(8, text('dotted underline', { flags: FLAG.DOTTED_UNDERLINE })),
    row(9, text('dashed underline', { flags: FLAG.DASHED_UNDERLINE })),
    row(10, text('undercurl', { flags: FLAG.UNDERCURL })),
    row(11, text('strikeout', { flags: FLAG.STRIKEOUT })),
    row(12, text('colored underline', { flags: FLAG.UNDERLINE, ulColor: indexedColor(1) })),
    row(13, [
      ...text('ansi: '),
      ...Array.from({ length: 16 }, (_, i) => cell('X', { fg: indexedColor(i) })),
    ]),
    row(14, [
      ...text('bg:   '),
      ...Array.from({ length: 16 }, (_, i) => cell(' ', { bg: indexedColor(i) })),
    ]),
    row(15, [
      ...text('rgb:  '),
      ...Array.from({ length: 24 }, (_, i) => cell('█', { fg: rgbColor(i * 10, 255 - i * 10, 128) })),
    ]),
    row(16, [
      ...text('cjk: '),
      cell('世', { flags: FLAG.WIDE, width: 2 }),
      cell('界', { flags: FLAG.WIDE, width: 2 }),
      ...text(' mixed kanji 漢'.slice(0, 13)),
      cell('漢', { flags: FLAG.WIDE, width: 2 }),
    ]),
    row(17, [
      ...text('emoji: '),
      cell('😀', { flags: FLAG.WIDE, width: 2 }),
      cell('🚀', { flags: FLAG.WIDE, width: 2 }),
      cell('✅'),
    ]),
    row(18, text('box: ┌─┬─┐ │ ├─┼─┤ └─┴─┘ ╭─╮ ╰─╯ ═ ║ ╔ ╗')),
    row(19, text('blocks: █▓▒░ ▀▄▌▐ ▁▂▃▄▅▆▇')),
    row(20, text('powerline:    ')),
  ];
  const f = syncFrame(cols, rows, runs);
  f.cursor = [21, 4]; // block cursor on an empty row, in-frame
  return f;
}
