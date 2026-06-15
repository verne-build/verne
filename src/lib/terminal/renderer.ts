// Renderer-agnostic contract. Both the Canvas2D and WebGL2 backends implement
// this so the rest of the terminal is renderer-independent and can fall back at
// runtime (WebGL context loss → Canvas2D).

import type { GridStore } from './GridStore';
import type { Palette } from './palette';

export interface FontMetrics {
  /** Advance width of one cell in CSS px. */
  cellWidth: number;
  /** Line height of one cell in CSS px. */
  cellHeight: number;
  /** Baseline offset from the cell top in CSS px. */
  baseline: number;
  fontFamily: string;
  fontSize: number;
}

/** Selection highlight range in absolute visual-line space (ordered). */
export interface SelectionRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** A single search-match highlight span, in absolute-line space. */
export interface SearchHighlight {
  line: number;
  col: number;
  len: number;
}

export interface TerminalRenderer {
  /** Recompute viewport geometry for a new grid size / device pixel ratio. */
  resize(cols: number, rows: number, dpr: number): void;
  /** Paint `store.dirtyRows` (then clear them). */
  paint(store: GridStore): void;
  /** Update font metrics (family/size/line-height change). */
  setMetrics(metrics: FontMetrics): void;
  /** Set (or clear) the selection highlight; the host repaints after. */
  setSelection(sel: SelectionRange | null): void;
  dispose(): void;

  // Optional host-driven knobs. Both backends implement them; callers guard with
  // `?.` so a future minimal renderer can omit them.
  /** Whether the cursor is currently drawn (toggled by the host blink timer). */
  cursorVisible?: boolean;
  setPalette?(p: Palette): void;
  setFocused?(on: boolean): void;
  /** Device pixel ratio for crisp lines (Canvas2D) / viewport scaling (WebGL2). */
  setDpr?(dpr: number): void;
  setLigatures?(on: boolean): void;
  setBoldIsBright?(on: boolean): void;
  setMinContrast?(ratio: number): void;
  /** Set (or clear with null) the search-match highlights; `current` is the index
   *  in `matches` drawn in the active color (-1 = none). Host repaints after. */
  setSearchMatches?(matches: SearchHighlight[] | null, current: number): void;
}
