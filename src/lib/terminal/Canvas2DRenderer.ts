// Canvas2D terminal renderer — the correctness backstop and WebGL fallback.
// Damage-driven: paints only the rows in `store.dirtyRows`. Drawing is done
// through a minimal 2D-context interface so it's unit-testable with a fake.

import type { Cell } from './gridProtocol';
import { ANY_UNDERLINE, FLAG } from './gridProtocol';
import { drawBoxGlyph, isBoxGlyph } from './boxGlyph';
import { cellFg as resolveCellFg } from './cellColor';
import type { GridStore } from './GridStore';
import { defaultPalette, resolveColor, type Palette } from './palette';
import type { FontMetrics, SearchHighlight, SelectionRange, TerminalRenderer } from './renderer';

/** The subset of CanvasRenderingContext2D the renderer uses. The renderer only
 *  ever assigns string colors, but the property type matches the real context
 *  so a CanvasRenderingContext2D is structurally assignable. */
export interface Ctx2DLike {
  /** Backing canvas; only dims are read (zero-size paint guard). Optional so
   *  test fakes can omit it. */
  canvas?: { width: number; height: number };
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textBaseline: string;
  /** Faint (SGR 2) text is drawn at reduced alpha so it blends toward the
   *  already-painted background. Optional so test fakes can ignore it. */
  globalAlpha?: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  /** Used to map a ligature run's natural shaped width onto its cell-grid span
   *  (see paintGlyphRuns). Only `.width` is read. */
  measureText(text: string): { width: number };
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
}

export interface Canvas2DOptions {
  metrics: FontMetrics;
  palette?: Palette;
  ligatures?: boolean;
  boldIsBright?: boolean;
  minContrast?: number;
}

export class Canvas2DRenderer implements TerminalRenderer {
  private ctx: Ctx2DLike;
  private metrics: FontMetrics;
  private palette: Palette;
  private cols = 0;
  private rows = 0;
  /** Device pixel ratio, for crisp 1-device-px box-drawing hairlines. */
  private dpr = 1;
  /** When true, contiguous same-style cells are drawn as one string so the
   *  font's ligatures (e.g. Fira Code) form; off draws per cell (no ligatures). */
  private ligatures: boolean;
  /** Map bold ANSI 0-7 fg to the bright 8-15 variant. */
  private boldIsBright: boolean;
  /** Minimum fg/bg contrast ratio to enforce (1 = off). */
  private minContrast: number;
  /** Drawn at the cursor position when true (toggled by the blink timer). */
  cursorVisible = true;
  /** Whether the terminal is focused — drives hollow cursor when blurred. */
  private cursorFocused = true;
  /** Active selection highlight (absolute visual-line space), or null. */
  private selection: SelectionRange | null = null;
  /** Search-match highlights (absolute-line space), or null. */
  private searchMatches: SearchHighlight[] | null = null;
  /** Index of the active match in `searchMatches` (-1 = none). */
  private searchActive = -1;

  constructor(ctx: Ctx2DLike, opts: Canvas2DOptions) {
    this.ctx = ctx;
    this.metrics = opts.metrics;
    this.palette = opts.palette ?? defaultPalette;
    this.ligatures = opts.ligatures ?? false;
    this.boldIsBright = opts.boldIsBright ?? false;
    this.minContrast = opts.minContrast ?? 1;
  }

  setPalette(p: Palette): void {
    this.palette = p;
  }

  setLigatures(on: boolean): void {
    this.ligatures = on;
  }

  setBoldIsBright(on: boolean): void {
    this.boldIsBright = on;
  }

  setMinContrast(ratio: number): void {
    this.minContrast = ratio;
  }

  setFocused(on: boolean): void {
    this.cursorFocused = on;
  }

  setDpr(dpr: number): void {
    this.dpr = dpr || 1;
  }

  setMetrics(metrics: FontMetrics): void {
    this.metrics = metrics;
  }

  setSelection(sel: SelectionRange | null): void {
    this.selection = sel;
  }

  setSearchMatches(matches: SearchHighlight[] | null, current: number): void {
    this.searchMatches = matches;
    this.searchActive = current;
  }

  resize(cols: number, rows: number, _dpr: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  paint(store: GridStore): void {
    // Hidden/zero-sized canvas: nothing to draw, and a clean repaint follows on
    // becoming visible (applySize + markAllDirty). Mirrors WebGL2Renderer.
    if (this.ctx.canvas && (this.ctx.canvas.width === 0 || this.ctx.canvas.height === 0)) return;
    const rows = [...store.dirtyRows].sort((a, b) => a - b);
    for (const r of rows) this.paintRow(store, r);
    store.clearDirty();
  }

  private cellFont(flags: number): string {
    const bold = flags & FLAG.BOLD ? 'bold ' : '';
    const italic = flags & FLAG.ITALIC ? 'italic ' : '';
    return `${italic}${bold}${this.metrics.fontSize}px ${this.metrics.fontFamily}`;
  }

  private cellFg(cell: Cell): string {
    return resolveCellFg(cell, this.palette, {
      boldIsBright: this.boldIsBright,
      minContrast: this.minContrast,
    });
  }

  /** Draw a single cell's glyph (used per-cell and for run-breaking cells). */
  private drawCellGlyph(cell: Cell, x: number, baselineY: number): void {
    if (cell.flags & FLAG.HIDDEN || cell.cp === 32 || cell.cp === 0) return;
    const { cellWidth, cellHeight, baseline } = this.metrics;
    this.ctx.fillStyle = this.cellFg(cell); // dim folded in (gamma-correct)
    // Box-drawing / block glyphs are painted to fill the cell so they connect
    // across rows regardless of line height (the font would leave gaps).
    if (isBoxGlyph(cell.cp)) {
      const w = (cell.width === 2 ? 2 : 1) * cellWidth;
      drawBoxGlyph(this.ctx, cell.cp, x, baselineY - baseline, w, cellHeight, this.dpr, baseline, this.metrics.fontSize);
      return;
    }
    this.ctx.font = this.cellFont(cell.flags);
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.fillText(this.glyph(cell), x, baselineY);
  }

  private paintRow(store: GridStore, row: number): void {
    if (row >= store.rows) return;
    const { cellWidth, cellHeight, baseline } = this.metrics;
    const y = row * cellHeight;
    const baselineY = y + baseline;
    const cells = store.visibleRow(row);

    // Pass 1a: backgrounds, coalescing runs of the same color into one rect.
    // Per-cell fills at fractional pixel x leave anti-aliased seams between
    // cells (visible as faint vertical lines through a solid background bar);
    // one rect per run has no internal seams.
    let runStart = -1;
    let runBg = '';
    const flushBg = (endCol: number) => {
      if (runStart >= 0) {
        this.ctx.fillStyle = runBg;
        this.ctx.fillRect(runStart * cellWidth, y, (endCol - runStart) * cellWidth, cellHeight);
      }
    };
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      if (cell.width === 0) continue; // spacer absorbed into the current run
      const inverse = (cell.flags & FLAG.INVERSE) !== 0;
      const bg = resolveColor(inverse ? cell.fg : cell.bg, this.palette, inverse);
      if (runStart < 0) {
        runStart = col;
        runBg = bg;
      } else if (bg !== runBg) {
        flushBg(col);
        runStart = col;
        runBg = bg;
      }
    }
    flushBg(cells.length);

    // Pass 1b: underlines + strikethrough (per cell — thin and uncommon).
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      if (cell.width === 0) continue;
      const deco = cell.flags & (ANY_UNDERLINE | FLAG.STRIKEOUT);
      if (!deco) continue;
      this.paintDecorations(cell, col * cellWidth, y, cellWidth, cellHeight);
    }

    // Selection highlight (over backgrounds, under glyphs).
    this.paintSelection(store, row, y, cellWidth, cellHeight);
    // Search highlights (over backgrounds + selection, under glyphs).
    this.paintSearchMatches(store, row, y, cellWidth, cellHeight);

    // Pass 2: glyphs.
    if (this.ligatures) this.paintGlyphRuns(cells, baselineY, cellWidth);
    else {
      for (let col = 0; col < cells.length; col++) {
        const cell = cells[col];
        if (cell.width === 0) continue;
        this.drawCellGlyph(cell, col * cellWidth, baselineY);
      }
    }

    // Cursor on its row. cursorRow() tracks the scroll offset so the cursor
    // stays glued to its line (and scrolls off-screen into history) instead of
    // detaching when scrolled within the sticky threshold.
    if (this.cursorVisible && row === store.cursorRow()) {
      this.paintCursor(store, cells, store.cursor[1], y, baselineY, cellWidth, cellHeight);
    }
  }

  /** Draw the cursor in the active shape. Unfocused → hollow outline regardless
   *  of shape; `hidden` → nothing. A focused block inverts the glyph beneath. */
  private paintCursor(
    store: GridStore,
    cells: Cell[],
    col: number,
    y: number,
    baselineY: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const shape = store.cursorShape;
    if (shape === 'hidden') return;
    const under = cells[col];
    // Span two cells over a wide char so the cursor covers the whole glyph.
    const cw = (under?.width === 2 ? 2 : 1) * cellWidth;
    const cx = col * cellWidth;
    const t = Math.max(1, Math.round(cellWidth / 6)); // bar/border thickness
    this.ctx.fillStyle = this.palette.cursor;

    if (!this.cursorFocused || shape === 'hollow') {
      // Hollow outline (top/bottom/left/right borders).
      this.ctx.fillRect(cx, y, cw, t);
      this.ctx.fillRect(cx, y + cellHeight - t, cw, t);
      this.ctx.fillRect(cx, y, t, cellHeight);
      this.ctx.fillRect(cx + cw - t, y, t, cellHeight);
      return;
    }
    if (shape === 'beam') {
      this.ctx.fillRect(cx, y, t, cellHeight);
      return;
    }
    if (shape === 'underline') {
      this.ctx.fillRect(cx, y + cellHeight - t, cw, t);
      return;
    }
    // Block: fill the cell and redraw the glyph in the background color.
    this.ctx.fillRect(cx, y, cw, cellHeight);
    if (under && under.cp !== 32 && under.cp !== 0) {
      this.ctx.font = this.cellFont(under.flags);
      this.ctx.textBaseline = 'alphabetic';
      this.ctx.fillStyle = this.palette.background;
      this.ctx.fillText(this.glyph(under), cx, baselineY);
    }
  }

  /** Draw underline (solid/double/dotted/dashed/undercurl) + strikethrough for
   *  one cell. Curves/dots are approximated with small rects (the renderer only
   *  needs fillRect). Underline uses the cell's underline color if set. */
  private paintDecorations(cell: Cell, x: number, y: number, cellWidth: number, cellHeight: number): void {
    const w = (cell.width === 2 ? 2 : 1) * cellWidth;
    const t = Math.max(1, Math.round(cellHeight / 16));
    const f = cell.flags;

    if (f & FLAG.STRIKEOUT) {
      this.ctx.fillStyle = this.cellFg(cell);
      this.ctx.fillRect(x, y + Math.round(cellHeight * 0.55) - Math.floor(t / 2), w, t);
    }

    if (!(f & ANY_UNDERLINE)) return;
    this.ctx.fillStyle =
      cell.ulColor !== undefined ? resolveColor(cell.ulColor, this.palette, true) : this.cellFg(cell);
    const uy = y + cellHeight - t - 1;
    if (f & FLAG.DOUBLE_UNDERLINE) {
      this.ctx.fillRect(x, uy - t - 1, w, t);
      this.ctx.fillRect(x, uy + t + 1, w, t);
    } else if (f & FLAG.DOTTED_UNDERLINE) {
      for (let dx = 0; dx < w; dx += 2 * t) this.ctx.fillRect(x + dx, uy, t, t);
    } else if (f & FLAG.DASHED_UNDERLINE) {
      const dash = Math.max(2 * t, Math.round(cellWidth / 3));
      for (let dx = 0; dx < w; dx += dash * 2) this.ctx.fillRect(x + dx, uy, dash, t);
    } else if (f & FLAG.UNDERCURL) {
      // Zigzag wave: alternate the dot one pixel up/down across the cell.
      for (let dx = 0; dx < w; dx += t) {
        const up = Math.floor(dx / t) % 2 === 0;
        this.ctx.fillRect(x + dx, uy + (up ? -1 : t), t, t);
      }
    } else {
      this.ctx.fillRect(x, uy, w, t); // plain underline
    }
  }

  /** Highlight the selected column span on this render row, if any. */
  private paintSelection(
    store: GridStore,
    row: number,
    y: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const sel = this.selection;
    if (!sel) return;
    const abs = store.absLineAt(row);
    if (abs < sel.startLine || abs > sel.endLine) return;
    const c0 = abs === sel.startLine ? sel.startCol : 0;
    const c1 = abs === sel.endLine ? sel.endCol : this.cols;
    if (c1 <= c0) return;
    this.ctx.fillStyle = this.palette.selection;
    this.ctx.fillRect(c0 * cellWidth, y, (c1 - c0) * cellWidth, cellHeight);
  }

  /** Highlight any search matches on this render row. */
  private paintSearchMatches(
    store: GridStore,
    row: number,
    y: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const ms = this.searchMatches;
    if (!ms) return;
    const abs = store.absLineAt(row);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.line !== abs) continue;
      this.ctx.fillStyle =
        i === this.searchActive ? this.palette.searchMatchCurrent : this.palette.searchMatch;
      this.ctx.fillRect(m.col * cellWidth, y, m.len * cellWidth, cellHeight);
    }
  }

  /** Draw glyphs as runs of contiguous same-style/colour single-width cells so
   *  the font's contextual ligatures form. Inverse/hidden/wide cells break the
   *  run and are drawn individually. */
  private paintGlyphRuns(cells: Cell[], baselineY: number, cellWidth: number): void {
    let runStart = -1;
    let runText = '';
    let runFg = '';
    let runStyle = -1;

    const flush = () => {
      const text = runText.replace(/\s+$/u, ''); // trailing blanks draw nothing
      if (runStart >= 0 && text !== '') {
        this.ctx.font = this.cellFont(runStyle);
        this.ctx.textBaseline = 'alphabetic';
        this.ctx.fillStyle = runFg; // dim folded into runFg (gamma-correct)
        // Map the run's natural shaped width onto its exact n-cell grid span.
        // cellWidth is the font advance ROUNDED to a whole device px (metrics
        // .cellWidthFor); drawing the run at its raw advance drifts off-grid and
        // the error ACCUMULATES across the line, sliding the text out from under
        // the block cursor (which sits at col×cellWidth). A horizontal scale of
        // gridW/natural pins every glyph origin to the grid. The factor is ~1 and
        // constant in n, so no visible distortion and no per-keystroke shift.
        const gridW = text.length * cellWidth;
        const natural = this.ctx.measureText(text).width;
        if (natural > 0 && Math.abs(natural - gridW) > 0.01) {
          this.ctx.save();
          this.ctx.translate(runStart * cellWidth, 0);
          this.ctx.scale(gridW / natural, 1);
          this.ctx.fillText(text, 0, baselineY);
          this.ctx.restore();
        } else {
          this.ctx.fillText(text, runStart * cellWidth, baselineY);
        }
      }
      runStart = -1;
      runText = '';
    };

    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      if (cell.width === 0) continue; // spacer
      const breaks =
        cell.width === 2 ||
        cell.flags & FLAG.INVERSE ||
        cell.flags & FLAG.HIDDEN ||
        isBoxGlyph(cell.cp);
      if (breaks) {
        flush();
        this.drawCellGlyph(cell, col * cellWidth, baselineY);
        continue;
      }
      const fg = this.cellFg(cell);
      const style = cell.flags & (FLAG.BOLD | FLAG.ITALIC | FLAG.DIM);
      if (runStart >= 0 && (fg !== runFg || style !== runStyle)) flush();
      if (runStart < 0) {
        runStart = col;
        runFg = fg;
        runStyle = style;
      }
      runText += this.glyph(cell);
    }
    flush();
  }

  private glyph(cell: Cell): string {
    let s = String.fromCodePoint(cell.cp);
    if (cell.zw) for (const c of cell.zw) s += String.fromCodePoint(c);
    return s;
  }

  dispose(): void {
    // No GPU resources to release for Canvas2D.
  }
}
