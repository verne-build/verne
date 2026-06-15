// Per-session terminal model: the live viewport grid + an LRU history cache +
// scroll (follow/freeze) state. Renderer-agnostic and headless-testable. Fed by
// decoded grid frames; the renderer reads `screen`/`dirtyRows`/`scrollOffset`.

import type {
  Cell,
  CursorShape,
  DecodedFrame,
  DeltaFrame,
  HistoryFrame,
  SyncFrame,
  WireModes,
} from './gridProtocol';
import type { LineMap } from './selection';

const BLANK: Cell = { cp: 32, fg: 0, bg: 0, flags: 0, width: 1 };
/** Placeholder for the column covered by the preceding wide char. width 0. */
const SPACER: Cell = { cp: 0, fg: 0, bg: 0, flags: 0, width: 0 };

/** Within this many rows of the bottom counts as "at bottom" → keep following. */
export const STICKY_THRESHOLD = 1;

const cloneCell = (c: Cell): Cell => ({ ...c, zw: c.zw ? [...c.zw] : undefined });

export class GridStore {
  cols = 0;
  rows = 0;
  rev = 0;
  cursor: [number, number] = [0, 0];
  cursorShape: CursorShape = 'block';
  cursorBlink = false;
  modes: WireModes = {
    mouseReporting: false,
    altScreen: false,
    appCursor: false,
    bracketedPaste: false,
  };
  /** Total VISUAL rows (scrollback history + live screen) reported by the
   *  server; the scroll extent. */
  totalLines = 0;
  /** Rows evicted off the top of scrollback so far (server `base`). A visual
   *  row's STABLE absolute id = base + its visual index. The history cache is
   *  keyed by stable id so eviction (which shifts content under fixed visual
   *  indices) doesn't strand stale rows, and the frozen-scroll anchor tracks
   *  `base + totalLines` (total rows ever produced) so it survives eviction. */
  base = 0;
  /** Live viewport: rows × cols. Wide chars occupy a cell + a width-0 spacer. */
  screen: Cell[][] = [];
  dirtyRows = new Set<number>();
  /** Continuous scroll position in visual rows up from the bottom (0 = following
   *  the live tail). Fractional: the wheel updates it sub-line so the scrollbar
   *  tracks the trackpad in real time, while content snaps to `scrollOffset`
   *  (the rounded row). Written only via setScrollPos/setScrollOffset/scrollToBottom. */
  private _scrollPos = 0;
  /** Whole visual row the content is rendered at (the rounded scroll position). */
  get scrollOffset(): number {
    return Math.round(this._scrollPos);
  }
  /** Continuous (fractional) scroll position — for the sub-pixel scrollbar. */
  get scrollPos(): number {
    return this._scrollPos;
  }
  /** Set when output arrives while frozen — drives the "jump to latest" pill. */
  hasNewOutputWhileScrolled = false;

  /** Per live-screen-row soft-wrap bit (parallels `screen`). */
  private screenWrapped: boolean[] = [];
  /** History wrap bits, keyed by stable id (parallels historyCache). */
  private historyWrapped = new Map<number, boolean>();

  private historyCache = new Map<number, Cell[]>();
  private historyLru: number[] = []; // most-recent first
  private readonly historyLimit: number;
  /** Visual lines requested from the server but not yet returned. Excluded from
   *  `missingHistory` so a re-evaluated fetch (one fires on every applied frame)
   *  doesn't re-request rows already on the wire — otherwise identical fetches
   *  pile up, saturating in-flight depth and ballooning round-trip latency. */
  private pendingHistory = new Set<number>();

  constructor(historyLimit = 2000) {
    this.historyLimit = historyLimit;
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.cols }, () => ({ ...BLANK }));
  }

  /** Lay out spacer-stripped cells into `row` starting at `startCol`, expanding
   *  wide chars into a cell + width-0 spacer. */
  private writeCells(row: Cell[], startCol: number, cells: Cell[]): void {
    let c = startCol;
    for (const cell of cells) {
      if (c >= this.cols) break;
      row[c] = cloneCell(cell);
      if (cell.width === 2 && c + 1 < this.cols) {
        row[c + 1] = { ...SPACER };
        c += 2;
      } else {
        c += 1;
      }
    }
  }

  /** Drop the whole scrollback cache. Used when stable ids stop being valid: a
   *  width reflow, or a `clear`/reset that wiped server scrollback while `base`
   *  stayed flat (so reborn rows would collide with stale cached ids). */
  private dropHistoryCache(): void {
    this.historyCache.clear();
    this.historyLru = [];
    this.historyWrapped.clear();
    this.pendingHistory.clear();
  }

  applyFrame(f: DecodedFrame): void {
    if (f.type === 'sync') this.applySync(f);
    else if (f.type === 'delta') this.applyDelta(f);
    else if (f.type === 'history') this.applyHistory(f);
    // 'searchResult' is handled by the host/session, not the grid model.
  }

  /** Bumped on every applied sync. Hosts watch it to invalidate state that a
   *  reflow breaks (e.g. the selection's absolute-line anchors). */
  syncGen = 0;

  applySync(f: SyncFrame): void {
    const prevCols = this.cols;
    // Total rows ever produced before this frame; monotonic under growth +
    // eviction, so a DROP means scrollback was wiped (`clear`/reset), not evicted.
    const prevProduced = this.base + this.totalLines;
    this.syncGen++;
    this.cols = f.cols;
    this.rows = f.rows;
    this.rev = f.rev;
    this.cursor = f.cursor;
    this.cursorShape = f.cursorShape ?? 'block';
    this.cursorBlink = f.cursorBlink ?? false;
    this.modes = f.modes;
    // Guard against an older daemon that omits the field (would NaN the scroll
    // math and blank the screen); fall back to no-scrollback.
    this.totalLines = Number.isFinite(f.totalLines) ? f.totalLines : this.rows;
    this.base = f.base ?? 0;
    this.screen = Array.from({ length: f.rows }, () => this.blankRow());
    this.screenWrapped = new Array(f.rows).fill(false);
    for (const run of f.runs) {
      if (run.line < f.rows) {
        this.writeCells(this.screen[run.line], run.startCol, run.cells);
        this.screenWrapped[run.line] = run.wrapped;
      }
    }
    this.dirtyRows = new Set(Array.from({ length: f.rows }, (_, i) => i));
    // A resync (reconnect / lag recovery) invalidates any outstanding requests.
    this.pendingHistory.clear();
    // Drop the cache when stable ids are no longer valid:
    //  - WIDTH change: rows cached at the old width hold differently-wrapped
    //    content (the duplicated-scrollback bug).
    //  - SHRINK (produced fell): a `clear`/reset wiped scrollback while base
    //    stayed flat, so cached rows now collide with reborn ids. The server
    //    forces a sync here precisely so we can drop them.
    // A same-width, non-shrinking resync (reconnect, lag recovery) keeps the
    // cache — stable ids stay valid and dropping would force a refetch storm.
    const produced = this.base + this.totalLines;
    if (f.cols !== prevCols || produced < prevProduced) {
      this.dropHistoryCache();
    }
    // The scroll extent may have shrunk under a frozen view — re-clamp so we
    // don't read off the (now shorter) end into stale/blank space.
    if (this._scrollPos > this.maxScrollOffset()) {
      this._scrollPos = this.maxScrollOffset();
    }
  }

  applyDelta(f: DeltaFrame): void {
    // Total rows EVER produced (= base + totalLines) — monotonic even when the
    // ring buffer is full and `totalLines` is pinned. The frozen anchor tracks
    // this so it survives both growth (base flat, total up) and eviction (total
    // pinned, base up); plain `totalLines` growth misses the eviction case.
    const prevProduced = this.base + this.totalLines;
    this.rev = f.rev;
    this.cursor = f.cursor;
    this.cursorShape = f.cursorShape ?? 'block';
    this.cursorBlink = f.cursorBlink ?? false;
    this.modes = f.modes;
    // Guard against an older daemon that omits the field (would NaN the scroll
    // math and blank the screen); fall back to no-scrollback.
    this.totalLines = Number.isFinite(f.totalLines) ? f.totalLines : this.rows;
    this.base = f.base ?? 0;
    // Always keep the live screen current (so returning to the bottom is exact).
    for (const run of f.runs) {
      if (run.line < this.rows) {
        this.writeCells(this.screen[run.line], run.startCol, run.cells);
        this.screenWrapped[run.line] = run.wrapped;
      }
    }
    // `clear`/reset wipes server scrollback and arrives here as a forced full
    // delta (NOT a sync): produced (base+total) DROPS while base stays flat, so
    // cached rows now collide with reborn stable ids. Drop them and re-clamp the
    // extent. Must run even at the bottom — `clear` is typed from the prompt.
    if (this.base + this.totalLines < prevProduced) {
      this.dropHistoryCache();
      if (this._scrollPos > this.maxScrollOffset()) this._scrollPos = this.maxScrollOffset();
      this.markAllDirty();
    }
    if (this.atBottom()) {
      // Inside the sticky band but not exactly at the tail → snap to 0: the
      // dirty marks below are screen-row indices (offset-0 space), and the view
      // should rejoin the live tail rather than sit one row above it.
      if (this._scrollPos !== 0) {
        this._scrollPos = 0;
        this.hasNewOutputWhileScrolled = false;
        this.markAllDirty();
      }
      // Following the tail: render row == screen row.
      for (const run of f.runs) if (run.line < this.rows) this.dirtyRows.add(run.line);
    } else {
      this.hasNewOutputWhileScrolled = true;
      // Frozen: as rows push into scrollback (growth) or fall off the top
      // (eviction) the view drifts unless we re-anchor by the produced growth,
      // then repaint the shifted window. Clamp so a frozen view whose content
      // has been fully evicted sticks at the oldest retained row.
      const grew = this.base + this.totalLines - prevProduced;
      if (grew > 0) {
        this._scrollPos = Math.min(this._scrollPos + grew, this.maxScrollOffset());
        this.markAllDirty();
      }
      // A shrink (clear/reset) is handled above, before this branch.
    }
  }

  applyHistory(f: HistoryFrame): void {
    // Key rows by their STABLE id (base-at-read + visual line), not the visual
    // index, so they stay valid as later eviction shifts visual indices. `from`
    // is a visual index in the server's frame; run.line == from + i.
    const frameBase = f.base ?? 0;
    for (const run of f.runs) {
      const row = this.blankRow();
      this.writeCells(row, run.startCol, run.cells);
      this.putHistory(frameBase + run.line, row);
      this.historyWrapped.set(frameBase + run.line, run.wrapped);
    }
    // The request completed: clear its whole stable-id range from pending.
    // Delivered rows are now cached; any undelivered in-range row becomes
    // eligible to re-fetch (a dropped row must not stay blocked forever).
    for (let i = f.from; i < f.to; i++) this.pendingHistory.delete(frameBase + i);
    // A scrolled-up view waiting on these rows needs to repaint.
    if (!this.atBottom()) this.markAllDirty();
  }

  /** Forget all outstanding history requests (cancel / resize / resync). Rows
   *  not yet cached become eligible to re-fetch instead of staying pinned. */
  clearPendingHistory(): void {
    this.pendingHistory.clear();
  }

  /** Mark visual lines `[from, to)` as requested-but-not-yet-returned. Only rows
   *  not already cached are tracked; call right before sending a `fetch`. */
  markHistoryRequested(from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const id = this.base + i;
      if (!this.historyCache.has(id)) this.pendingHistory.add(id);
    }
  }

  // ---- history cache (LRU by STABLE id = base + visual line index) ----

  /** Cache a row by its STABLE id (caller-supplied). */
  private putHistory(id: number, row: Cell[]): void {
    if (this.historyCache.has(id)) {
      this.historyCache.set(id, row);
      this.touchLru(id);
      return;
    }
    this.historyCache.set(id, row);
    this.historyLru.unshift(id);
    while (this.historyLru.length > this.historyLimit) {
      const evict = this.historyLru.pop()!;
      this.historyCache.delete(evict);
      this.historyWrapped.delete(evict);
    }
  }

  /** Cached row for a VISUAL line index (resolved to its stable id via `base`). */
  getHistory(line: number): Cell[] | undefined {
    const id = this.base + line;
    const row = this.historyCache.get(id);
    if (row) this.touchLru(id);
    return row;
  }

  hasHistory(line: number): boolean {
    return this.historyCache.has(this.base + line);
  }

  /** Visual line indices in `[from, to)` neither cached nor already requested —
   *  what still needs a `fetch`. */
  missingHistory(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = from; i < to; i++) {
      const id = this.base + i;
      if (!this.historyCache.has(id) && !this.pendingHistory.has(id)) out.push(i);
    }
    return out;
  }

  private touchLru(line: number): void {
    const i = this.historyLru.indexOf(line);
    if (i >= 0) this.historyLru.splice(i, 1);
    this.historyLru.unshift(line);
  }

  get cachedHistoryCount(): number {
    return this.historyCache.size;
  }

  // ---- visual-row access (what the renderer paints) ----

  /** First column where the live screen begins in absolute visual-line space. */
  private screenStart(): number {
    return Math.max(0, this.totalLines - this.rows);
  }

  /** Cells for an absolute visual line: live screen or cached history (a blank
   *  row when history hasn't arrived yet). */
  lineCells(abs: number): Cell[] {
    const start = this.screenStart();
    if (abs >= start) return this.screen[abs - start] ?? this.blankRow();
    return this.getHistory(abs) ?? this.blankRow();
  }

  /** True if absolute visual line `abs` soft-wraps into the next (for copy). */
  isWrapped(abs: number): boolean {
    const start = this.screenStart();
    if (abs >= start) return this.screenWrapped[abs - start] ?? false;
    return this.historyWrapped.get(this.base + abs) ?? false; // stable id (matches getHistory)
  }

  /** Cells for render row `r` (0..rows) under the current scroll offset. */
  visibleRow(r: number): Cell[] {
    return this.lineCells(this.screenStart() - this.scrollOffset + r);
  }

  /** Plain text of an absolute visual line (trailing blanks trimmed). */
  lineText(abs: number): string {
    return this.lineMap(abs).text;
  }

  /** Text + cell-col ↔ UTF-16-index maps for an absolute visual line. Selection,
   *  copy, word-select and regex link detection all need this because wide chars
   *  and astral code points make columns ≠ string indices. */
  lineMap(abs: number): LineMap {
    const cells = this.lineCells(abs);
    let text = '';
    const colToIdx: number[] = [];
    const idxToCol: number[] = [];
    let endCol = 0; // col just past the last content cell
    for (let col = 0; col < cells.length; col++) {
      const c = cells[col];
      colToIdx.push(text.length); // spacers land AFTER their wide char's content
      if (c.width === 0) continue;
      let s = String.fromCodePoint(c.cp);
      if (c.zw) for (const z of c.zw) s += String.fromCodePoint(z);
      for (let k = 0; k < s.length; k++) idxToCol.push(col);
      text += s;
      endCol = col + (c.width === 2 ? 2 : 1);
    }
    const trimmed = text.replace(/\s+$/u, '');
    if (trimmed.length !== text.length) {
      idxToCol.length = trimmed.length;
      for (let col = 0; col < colToIdx.length; col++) {
        if (colToIdx[col] > trimmed.length) colToIdx[col] = trimmed.length;
      }
      endCol = trimmed.length
        ? idxToCol[trimmed.length - 1] +
          (cells[idxToCol[trimmed.length - 1]].width === 2 ? 2 : 1)
        : 0;
    }
    colToIdx.push(trimmed.length); // sentinel: [cells.length]
    idxToCol.push(endCol); // sentinel: [trimmed.length]
    return { text: trimmed, colToIdx, idxToCol };
  }

  /** Absolute visual line shown at render row `r`. */
  absLineAt(r: number): number {
    return this.screenStart() - this.scrollOffset + r;
  }

  /** Render row (0..rows) where the live cursor sits under the current scroll
   *  offset. The cursor lives at screen row `cursor[0]`; scrolling shifts the
   *  whole window down by `scrollOffset`, so it tracks down with its line and
   *  goes off-screen (>= rows) once scrolled far enough into history. */
  cursorRow(): number {
    return this.cursor[0] + this.scrollOffset;
  }

  /** OSC-8 hyperlink at absolute line `abs`, column `col`, expanded to the
   *  contiguous run of cells carrying the same URI. Null when the cell has no
   *  emulator-provided hyperlink. */
  linkAt(abs: number, col: number): { value: string; start: number; len: number } | null {
    const cells = this.lineCells(abs);
    const uri = cells[col]?.link;
    if (uri === undefined) return null;
    let start = col;
    while (start > 0 && cells[start - 1]?.link === uri) start--;
    let end = col;
    while (end + 1 < cells.length && cells[end + 1]?.link === uri) end++;
    return { value: uri, start, len: end - start + 1 };
  }

  // ---- scroll (follow / freeze) ----

  maxScrollOffset(): number {
    return Math.max(0, this.totalLines - this.rows);
  }

  atBottom(): boolean {
    return this.scrollOffset <= STICKY_THRESHOLD;
  }

  scrollToBottom(): void {
    if (this._scrollPos !== 0) this.markAllDirty();
    this._scrollPos = 0;
    this.hasNewOutputWhileScrolled = false;
  }

  setScrollOffset(n: number): void {
    const next = Math.max(0, Math.min(this.maxScrollOffset(), n));
    if (next === this._scrollPos) return;
    this._scrollPos = next;
    if (this.atBottom()) this.hasNewOutputWhileScrolled = false;
    this.markAllDirty(); // the whole window shifted
  }

  /** Set the continuous scroll position (fractional rows). Only repaints content
   *  when the rounded row changes; the host refreshes the scrollbar every call
   *  so the thumb tracks sub-line motion. */
  setScrollPos(f: number): void {
    const next = Math.max(0, Math.min(this.maxScrollOffset(), f));
    if (next === this._scrollPos) return;
    const prevRow = this.scrollOffset;
    this._scrollPos = next;
    if (this.atBottom()) this.hasNewOutputWhileScrolled = false;
    if (this.scrollOffset !== prevRow) this.markAllDirty(); // content row shifted
  }

  /** Mark every render row dirty (window shifted / palette change). */
  markAllDirty(): void {
    for (let i = 0; i < this.rows; i++) this.dirtyRows.add(i);
  }

  clearDirty(): void {
    this.dirtyRows.clear();
  }
}
