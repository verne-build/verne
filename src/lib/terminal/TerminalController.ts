// Wires the terminal pieces together: GridStore (model) + GridSession
// (transport) + TerminalRenderer (paint) + input mapping + IME. DOM-agnostic
// and dependency-injected so it's unit-testable; the Vue host feeds it real DOM
// events and a real renderer/session.

import { GridStore } from './GridStore';
import { Ime } from './ime';
import {
  isAppShortcut,
  keyEventToSemantic,
  mouseButton,
  pixelToCell,
  type KeyLike,
} from './inputMapping';
import type { FontMetrics, SearchHighlight, TerminalRenderer } from './renderer';
import type { Mods, MouseAction, SearchResultFrame } from './gridProtocol';
import {
  colToIndex,
  flattenSelection,
  indexToCol,
  orderSelection,
  wordRange,
  type Pos,
} from './selection';
import { detectLinks, linkAt as findLink, type LinkMatch } from './links';

/** Auto-scroll tick interval while drag-selecting past the viewport edge. */
const AUTOSCROLL_INTERVAL_MS = 40;
/** Max rows/tick at full acceleration (pointer far past the edge). */
const AUTOSCROLL_MAX_ROWS = 6;

/** Prefetch this many screenfuls of scrollback on each side of the viewport. */
const FETCH_MARGIN_SCREENS = 2;
/** Extra screenfuls fetched ahead in the current scroll direction (so a fling
 *  doesn't outrun the cache and flash blank rows). */
const FETCH_LOOKAHEAD_SCREENS = 2;
/** Warm this many screenfuls just above the live tail while following, so the
 *  first scroll-up paints instantly instead of waiting a round-trip. */
const TAIL_PREFETCH_SCREENS = 2;
/** Min gap between tail-prefetch fetches (ms) — bounds churn during a flood,
 *  where the rows just above the tail keep scrolling away before they're read. */
const TAIL_PREFETCH_THROTTLE_MS = 120;

/** Max time (ms) to keep showing the pre-resize frame while waiting for the
 *  program's own post-SIGWINCH repaint. Long enough for a full-screen TUI redraw
 *  (tens of ms typical), short enough that a program which never repaints (dead
 *  child, plain idle shell) doesn't leave a visibly stale pane. */
export const RESIZE_HOLD_MS = 200;
/** Quiet period after the latest post-resize program delta before revealing the
 *  new frame. Grid deltas are coalesced at 8ms; eight quiet intervals cover the
 *  measured multi-delta Codex redraw gap. */
export const RESIZE_SETTLE_MS = 64;

/** The transport a controller drives: the live socket-backed `GridSession`, or a
 *  no-op `StaticGridTransport` for a frozen archived snapshot. Structural so both
 *  satisfy it without a shared base class. Covers exactly the surface the
 *  controller touches. */
export interface GridTransport {
  readonly store: GridStore;
  /** Called after each applied grid frame so the renderer can repaint. */
  onUpdate?: () => void;
  /** Called when a search reply arrives. */
  onSearchResult?: (r: SearchResultFrame) => void;
  sendKey(key: string, mods?: Mods): void;
  sendText(text: string): void;
  sendPaste(text: string): void;
  sendMouse(action: MouseAction, button: number, col: number, row: number, mods?: Mods): void;
  fetchHistory(from: number, to: number): number;
  cancelHistory(reqId: number): void;
  cancelAllFetches(): void;
  search(query: string, opts?: { limit?: number; caseSensitive?: boolean }): number;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface ControllerDeps {
  store: GridStore;
  transport: GridTransport;
  renderer: TerminalRenderer;
  metrics: FontMetrics;
  /** Read-only (archived snapshot): suppress all input/fetch/resize forwarding;
   *  keep selection, scroll, copy, link detection, repaint. */
  readOnly?: boolean;
  ime?: Ime;
  /** Paint scheduler (rAF in the app; synchronous in tests). */
  schedule?: (cb: () => void) => void;
  /** Monotonic clock for throttling (performance.now in the app; injectable in
   *  tests). */
  clock?: () => number;
  /** Interval scheduler for drag auto-scroll (setInterval in the app; injectable
   *  in tests). Returns a handle passed back to `clearAutoScroll`. */
  setAutoScroll?: (cb: () => void, ms: number) => unknown;
  clearAutoScroll?: (handle: unknown) => void;
  /** One-shot timer for the resize hold deadline (setTimeout in the app). */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface ResizeHold {
  cols: number;
  rows: number;
  sawSync: boolean;
  deadlineTimer: unknown | null;
  settleTimer: unknown | null;
}

export class TerminalController {
  readonly store: GridStore;
  readonly transport: GridTransport;
  private readonly readOnly: boolean;
  /** Mutable so the host can swap backends at runtime (WebGL2 context loss →
   *  Canvas2D). Use `setRenderer` to swap so selection is re-applied. */
  renderer: TerminalRenderer;
  readonly ime: Ime;
  /** Called after each paint so the host can refresh scroll UI (scrollbar,
   *  jump-to-latest). */
  onAfterPaint?: () => void;
  /** Called on every continuous wheel step so the host can move the scrollbar
   *  thumb sub-line, even when the content row (and thus the paint) didn't change. */
  onScroll?: () => void;
  /** Called when a resize commits, immediately before the renderer is resized and
   *  repainted. The host resizes the canvas backing store here — doing it earlier
   *  would clear the very frame the hold is preserving. */
  onResizeCommit?: (cols: number, rows: number) => void;
  private metrics: FontMetrics;
  private schedule: (cb: () => void) => void;
  private clock: () => number;
  private paintQueued = false;
  /** Accumulates fractional wheel rows for the discrete (mouse-reporting /
   *  alt-screen) paths, which must emit whole-line events. Reset in local mode. */
  private wheelAccum = 0;
  /** Previous scroll offset — used to derive the direction of travel for
   *  directional prefetch lookahead. */
  private prevOffset = 0;
  /** Timestamp of the last tail prefetch (for throttling). */
  private lastTailPrefetch = -Infinity;
  /** Last seen store.syncGen — a bump means a sync (possible reflow) landed. */
  private lastSyncGen = 0;
  /** Last seen store.deltaGen — a bump means a real delta (program output) landed,
   *  as opposed to history/search traffic. */
  private lastDeltaGen = 0;
  /** Selection anchor/head in absolute visual-line space; null when none. */
  private sel: { anchor: Pos; head: Pos } | null = null;
  private selecting = false;
  private autoScrollHandle: unknown = null;
  /** Last drag pointer (canvas px) — the auto-scroll tick re-reads it. */
  private dragPointer: { px: number; py: number } | null = null;
  private setAutoScroll: (cb: () => void, ms: number) => unknown;
  private clearAutoScroll: (handle: unknown) => void;
  private setTimer: (cb: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;
  /** In-flight resize hold: painting is suppressed (the canvas still shows the
   *  pre-resize frame) until the program repaints or the deadline fires.
   *  Known window: pointer mapping (pixelToCell) reads the store's NEW cols/rows
   *  while the canvas still shows the old frame, so click/word-select and link
   *  hover map to the wrong cells for the hold's duration. Fixing it needs a
   *  shadow copy of the pre-resize grid; ≤200ms mid-resize was judged not worth
   *  it. */
  private hold: ResizeHold | null = null;

  /** reqId of the latest in-flight scrollback fetch; cancelled when superseded. */
  private lastFetchReqId = 0;

  // ---- search ----
  private searchMatches: SearchHighlight[] = [];
  private searchActive = -1;
  /** reqId of the latest in-flight search; replies with other ids are stale. */
  private searchReqId = 0;
  private readonly handleTransportUpdate: () => void = () => {
    const synced = this.store.syncGen !== this.lastSyncGen;
    if (synced) {
      this.lastSyncGen = this.store.syncGen;
      // A sync may have reflowed the grid → absolute-line selection anchors
      // are stale. Drop the selection rather than highlight the wrong text.
      if (this.sel) this.clearSelection();
      // Resync invalidates outstanding fetches; clear so post-resync fetches
      // aren't deduped against dead reqIds (store clears pendingHistory in applySync).
      this.transport.cancelAllFetches();
      this.lastFetchReqId = 0;
    }
    const newDelta = this.store.deltaGen !== this.lastDeltaGen;
    this.lastDeltaGen = this.store.deltaGen;
    // Resize hold: the daemon answers a resize with a full sync of the screen
    // reflowed but NOT yet repainted by the program. Keep suppressing paints
    // through it; real DELTAs after it restart a short quiet window so a TUI's
    // clear/home and content phases land as one visible repaint.
    // Must be a delta, not merely "not a sync": the width reflow drops the
    // history cache, so `history` frames stream back within milliseconds and
    // would otherwise release the hold onto the mangled intermediate.
    if (this.hold) {
      // Only the snapshot for THIS resize counts — a sync still carrying the
      // previous geometry (two resizes in flight) must not arm the release.
      if (synced) {
        if (this.hold.settleTimer != null) {
          this.clearTimer(this.hold.settleTimer);
          this.hold.settleTimer = null;
        }
        this.hold.sawSync = this.store.cols === this.hold.cols && this.store.rows === this.hold.rows;
      } else if (newDelta && this.hold.sawSync) {
        const hold = this.hold;
        if (hold.settleTimer != null) this.clearTimer(hold.settleTimer);
        hold.settleTimer = this.setTimer(() => {
          if (this.hold === hold) this.commitResize();
        }, RESIZE_SETTLE_MS);
      }
    }
    this.requestPaint();
    // Following the tail → warm the cache just above it for an instant first
    // scroll-up; scrolled up → the window may have shifted, refill it.
    if (this.store.atBottom()) this.prefetchAboveTail();
    else this.fetchVisible();
  };
  private readonly handleTransportSearchResult = (r: SearchResultFrame) => this.onSearchResult(r);

  constructor(deps: ControllerDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.readOnly = deps.readOnly ?? false;
    this.renderer = deps.renderer;
    this.metrics = deps.metrics;
    this.ime = deps.ime ?? new Ime();
    this.schedule = deps.schedule ?? ((cb) => cb());
    this.clock = deps.clock ?? (() => performance.now());
    this.setAutoScroll = deps.setAutoScroll ?? ((cb, ms) => setInterval(cb, ms) as unknown);
    this.clearAutoScroll = deps.clearAutoScroll ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.lastSyncGen = this.store.syncGen;
    this.lastDeltaGen = this.store.deltaGen;

    this.transport.onUpdate = this.handleTransportUpdate;
    this.ime.onCommit = (text) => {
      if (this.readOnly) return;
      this.transport.sendText(text);
    };
    this.transport.onSearchResult = this.handleTransportSearchResult;
    // onPreedit is wired by the host to the renderer's inline preedit overlay.
  }

  private requestPaint(): void {
    if (this.hold) return; // holding the pre-resize frame
    if (this.paintQueued) return;
    this.paintQueued = true;
    this.schedule(() => {
      if (!this.paintQueued) return;
      this.paintQueued = false;
      // Re-check: a paint queued before the resize would otherwise land mid-hold
      // (rAF phase is uncorrelated with when the resize arrives).
      if (this.hold) return;
      this.renderer.paint(this.store);
      this.onAfterPaint?.();
    });
  }

  /** Force an immediate repaint (e.g. after theme/font change). */
  repaint(): void {
    if (this.hold) return; // holding the pre-resize frame
    this.renderer.paint(this.store);
    this.onAfterPaint?.();
  }

  /** Apply new font metrics to the renderer + pixel→cell mapping. */
  setMetrics(metrics: FontMetrics): void {
    this.metrics = metrics;
    this.renderer.setMetrics(metrics);
  }

  /** Swap the active renderer (e.g. WebGL2 context loss → Canvas2D). Re-applies
   *  the current selection; the host re-applies metrics/dpr/palette/size and
   *  repaints. */
  setRenderer(renderer: TerminalRenderer): void {
    this.renderer = renderer;
    this.applySelection();
    this.renderer.setSearchMatches?.(this.searchMatches.length ? this.searchMatches : null, this.searchActive);
  }

  /** Handle a keydown. Returns true if it was consumed as terminal input. */
  handleKeyDown(e: KeyLike): boolean {
    if (this.readOnly) return false; // archived snapshot accepts no input
    if (this.ime.composing) return false; // let composition run
    if (isAppShortcut(e)) return false; // app handles it
    const sem = keyEventToSemantic(e);
    if (!sem) return false; // plain text → flows through the input/composition path
    this.clearSelection();
    this.snapToBottomOnInput();
    this.transport.sendKey(sem.key, sem.mods);
    return true;
  }

  /** Committed text from the `input` event path (non-IME printable input). */
  handleText(text: string): void {
    if (this.readOnly) return; // archived snapshot accepts no input
    if (!text) return;
    this.clearSelection();
    this.snapToBottomOnInput();
    this.transport.sendText(text);
  }

  handlePaste(text: string): void {
    if (this.readOnly) return; // archived snapshot accepts no input
    if (!text) return;
    this.snapToBottomOnInput();
    this.transport.sendPaste(text);
  }

  /** Pointer event at canvas-relative pixels. Routes to the app (mouse mode on)
   *  or returns the cell for local selection (mouse mode off). */
  handlePointer(
    action: MouseAction,
    button: number,
    px: number,
    py: number,
    mods: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean } = {},
  ): { col: number; row: number } | null {
    const { col, row } = pixelToCell(px, py, this.metrics, this.store.cols, this.store.rows);
    // Read-only: never forward to a PTY; always hand back the cell so the host
    // drives local selection (the frozen grid has no app to report to).
    if (this.store.modes.mouseReporting && !this.readOnly) {
      this.transport.sendMouse(action, mouseButton(button), col, row, mods);
      return null;
    }
    return { col, row }; // host drives local selection
  }

  /** Wheel at canvas-relative pixels (px,py). `deltaRows` is signed, fractional
   *  rows; > 0 = scroll up / toward history. Routing:
   *   - mouse reporting on  → forward as wheel mouse events at the pointer cell;
   *   - else alt-screen     → send arrow keys (alternate-scroll convention);
   *   - else                → local scrollback, sub-line continuous (the
   *     scrollbar tracks the trackpad; content snaps to the rounded row). */
  handleWheel(deltaRows: number, px = 0, py = 0): void {
    if (deltaRows === 0) return;

    // Discrete paths emit whole-line events, so accumulate the fractional rows.
    // Read-only always uses local scrollback: a frozen grid has no live program
    // to send wheel/arrow events to, regardless of its captured modes.
    if (!this.readOnly && (this.store.modes.mouseReporting || this.store.modes.altScreen)) {
      this.wheelAccum += deltaRows;
      const lines = Math.trunc(this.wheelAccum);
      if (lines === 0) return;
      this.wheelAccum -= lines;
      const up = lines > 0;
      const n = Math.min(5, Math.abs(lines));
      if (this.store.modes.mouseReporting) {
        const { col, row } = pixelToCell(px, py, this.metrics, this.store.cols, this.store.rows);
        const action: MouseAction = up ? 'wheelUp' : 'wheelDown';
        for (let i = 0; i < n; i++) this.transport.sendMouse(action, 0, col, row);
      } else {
        const key = up ? 'ArrowUp' : 'ArrowDown';
        for (let i = 0; i < n; i++) this.transport.sendKey(key, {});
      }
      return;
    }

    // Local scrollback: move the continuous position 1:1 with the wheel (which
    // carries the OS trackpad's own inertia), refresh the scrollbar every step,
    // and only repaint/fetch when the rounded content row actually changes.
    this.wheelAccum = 0;
    const prev = this.store.scrollOffset;
    this.store.setScrollPos(this.store.scrollPos + deltaRows);
    this.onScroll?.();
    if (this.store.scrollOffset !== prev) {
      this.fetchVisible();
      this.requestPaint();
    }
  }

  /** Scroll to a given offset (rows from bottom) — for the scrollbar drag. */
  scrollTo(offset: number): void {
    this.store.setScrollOffset(offset);
    this.fetchVisible();
    this.requestPaint();
  }

  /** Jump back to following the live tail. */
  jumpToBottom(): void {
    this.store.scrollToBottom();
    this.requestPaint();
  }

  /** Request the visible scrollback rows (plus margin, and extra lookahead in
   *  the scroll direction) that aren't cached yet. No-op while following the
   *  tail. */
  fetchVisible(): void {
    if (this.readOnly) return; // full history pre-seeded; nothing to fetch
    const s = this.store;
    const scrollbackEnd = s.maxScrollOffset(); // = totalLines - rows
    if (s.atBottom() || scrollbackEnd <= 0) return;
    const margin = s.rows * FETCH_MARGIN_SCREENS;
    const ahead = s.rows * FETCH_LOOKAHEAD_SCREENS;
    // scrollOffset grows toward older history (up); shrinks toward the tail.
    const dir = s.scrollOffset > this.prevOffset ? 1 : s.scrollOffset < this.prevOffset ? -1 : 0;
    this.prevOffset = s.scrollOffset;
    const from = Math.max(0, s.absLineAt(0) - margin - (dir > 0 ? ahead : 0));
    const to = Math.min(scrollbackEnd, s.absLineAt(s.rows) + margin + (dir < 0 ? ahead : 0));
    if (from >= to || s.missingHistory(from, to).length === 0) return;
    // Supersede: a new visible range means the prior fetch (likely a different
    // range after a direction change / scroll) is obsolete — cancel its stream.
    if (this.lastFetchReqId) {
      this.transport.cancelHistory(this.lastFetchReqId);
      s.clearPendingHistory(); // cancelled rows must not stay pinned (unfetchable)
    }
    s.markHistoryRequested(from, to); // dedup: don't re-request rows on the wire
    this.lastFetchReqId = this.transport.fetchHistory(from, to);
  }

  /** While following the tail, warm the cache just above the live screen so the
   *  first scroll-up paints instantly. Throttled: during a flood the rows just
   *  above the tail keep scrolling away unread, so refetching them every frame
   *  is wasted work (and competes with live deltas for the emulator lock). */
  prefetchAboveTail(): void {
    if (this.readOnly) return; // full history pre-seeded; nothing to prefetch
    const s = this.store;
    const end = s.maxScrollOffset(); // abs index of the live screen's top row
    if (end <= 0) return;
    const now = this.clock();
    if (now - this.lastTailPrefetch < TAIL_PREFETCH_THROTTLE_MS) return;
    const from = Math.max(0, end - s.rows * TAIL_PREFETCH_SCREENS);
    if (from >= end || s.missingHistory(from, end).length === 0) return;
    this.lastTailPrefetch = now;
    s.markHistoryRequested(from, end);
    this.transport.fetchHistory(from, end);
  }

  // ---- selection (local; mouse-reporting-off only) ----

  /** Pixel → absolute-visual-line position. */
  private posAt(px: number, py: number): Pos {
    const { col, row } = pixelToCell(px, py, this.metrics, this.store.cols, this.store.rows);
    return { line: this.store.absLineAt(row), col };
  }

  selectionStart(px: number, py: number): void {
    const p = this.posAt(px, py);
    this.sel = { anchor: p, head: p };
    this.selecting = true;
    this.applySelection();
  }

  selectionUpdate(px: number, py: number): void {
    if (!this.selecting || !this.sel) return;
    this.dragPointer = { px, py };
    this.sel.head = this.posAt(px, py);
    this.applySelection();
    this.updateAutoScroll(py);
  }

  /** Start/stop the auto-scroll loop based on how far `py` is past the viewport
   *  vertical bounds. Step size accelerates with distance. */
  private updateAutoScroll(py: number): void {
    const vh = this.store.rows * this.metrics.cellHeight;
    const past = py < 0 ? py : py > vh ? py - vh : 0; // signed px beyond edge
    if (past === 0) {
      this.stopAutoScroll();
      return;
    }
    if (this.autoScrollHandle == null) {
      this.autoScrollHandle = this.setAutoScroll(() => this.autoScrollTick(), AUTOSCROLL_INTERVAL_MS);
    }
  }

  private autoScrollTick(): void {
    if (!this.selecting || !this.sel || !this.dragPointer) {
      this.stopAutoScroll();
      return;
    }
    const { px, py } = this.dragPointer;
    const ch = this.metrics.cellHeight;
    const vh = this.store.rows * ch;
    const past = py < 0 ? py : py > vh ? py - vh : 0;
    if (past === 0) {
      this.stopAutoScroll();
      return;
    }
    // Distance-based acceleration: 1 row near the edge → MAX_ROWS far out.
    const mag = Math.min(AUTOSCROLL_MAX_ROWS, Math.ceil(Math.abs(past) / ch));
    // py<0 → scroll up (toward history): scrollOffset increases. py>vh → down.
    const dir = past < 0 ? 1 : -1;
    const before = this.store.scrollOffset;
    this.store.setScrollOffset(this.store.scrollOffset + dir * mag);
    if (this.store.scrollOffset === before) {
      this.stopAutoScroll(); // hit the scroll extent
      return;
    }
    // Extend the selection head to the clamped edge row in the new window.
    this.sel.head = this.posAt(px, py);
    this.applySelection();
    this.fetchVisible();
  }

  private stopAutoScroll(): void {
    if (this.autoScrollHandle != null) {
      this.clearAutoScroll(this.autoScrollHandle);
      this.autoScrollHandle = null;
    }
  }

  selectionEnd(): void {
    this.selecting = false;
    this.dragPointer = null;
    this.stopAutoScroll();
  }

  /** Double-click: select the word under the pointer. Word boundaries run in
   *  string space (lineMap.text); the stored selection is cell cols. */
  selectWordAt(px: number, py: number): void {
    const p = this.posAt(px, py);
    const m = this.store.lineMap(p.line);
    const r = wordRange(m.text, colToIndex(m, p.col));
    this.sel = {
      anchor: { line: p.line, col: indexToCol(m, r.start) },
      head: { line: p.line, col: indexToCol(m, r.end) },
    };
    this.selecting = false;
    this.applySelection();
  }

  hasSelection(): boolean {
    if (!this.sel) return false;
    const { anchor, head } = this.sel;
    return anchor.line !== head.line || anchor.col !== head.col;
  }

  /** The selected text (empty when there's no selection). */
  copySelection(): string {
    if (!this.hasSelection()) return '';
    const ord = orderSelection(this.sel!.anchor, this.sel!.head);
    return flattenSelection(ord, (line) => this.store.lineMap(line), (line) => this.store.isWrapped(line));
  }

  clearSelection(): void {
    if (!this.sel) return;
    this.sel = null;
    this.selecting = false;
    this.stopAutoScroll();
    this.renderer.setSelection(null);
    this.requestPaint();
  }

  private applySelection(): void {
    if (!this.sel) return;
    const ord = orderSelection(this.sel.anchor, this.sel.head);
    this.renderer.setSelection({
      startLine: ord.start.line,
      startCol: ord.start.col,
      endLine: ord.end.line,
      endCol: ord.end.col,
    });
    this.requestPaint();
  }

  // ---- search ----

  get searchMatchCount(): number {
    return this.searchMatches.length;
  }
  get searchActiveIndex(): number {
    return this.searchActive;
  }
  /** Live match list (absolute-line space) — for the scrollbar ticks. */
  get searchMatchList(): readonly SearchHighlight[] {
    return this.searchMatches;
  }

  /** Run a search; empty query clears. Results arrive async via onSearchResult. */
  search(query: string, caseSensitive: boolean): void {
    if (!query) {
      this.clearSearch();
      return;
    }
    this.searchReqId = this.transport.search(query, { caseSensitive });
  }

  searchNext(): void {
    this.stepMatch(1);
  }
  searchPrev(): void {
    this.stepMatch(-1);
  }

  clearSearch(): void {
    this.searchMatches = [];
    this.searchActive = -1;
    this.searchReqId = 0;
    this.renderer.setSearchMatches?.(null, -1);
    this.store.markAllDirty();
    this.requestPaint();
  }

  private onSearchResult(r: SearchResultFrame): void {
    if (r.reqId !== this.searchReqId) return; // stale reply
    // Daemon sends a single terminal frame (done=true) with the full match set;
    // if partial/streaming results are ever added, accumulate on !r.done here.
    this.searchMatches = r.matches;
    this.searchActive = r.matches.length ? this.nearestMatchIndex() : -1;
    this.applySearch();
  }

  /** First match at/after the current viewport top, else 0 — so opening find near
   *  where you are selects a nearby match instead of jumping to the top. */
  private nearestMatchIndex(): number {
    const top = this.store.absLineAt(0);
    const idx = this.searchMatches.findIndex((m) => m.line >= top);
    return idx >= 0 ? idx : this.searchMatches.length - 1; // all above viewport → nearest (last)
  }

  private stepMatch(dir: number): void {
    const n = this.searchMatches.length;
    if (!n) return;
    this.searchActive = (this.searchActive + dir + n) % n;
    this.applySearch();
  }

  private applySearch(): void {
    this.renderer.setSearchMatches?.(this.searchMatches.length ? this.searchMatches : null, this.searchActive);
    const m = this.searchMatches[this.searchActive];
    if (m) this.revealLine(m.line);
    // Canvas2D is damage-driven; recoloring/highlighting without new output needs
    // a full repaint (revealLine only marks dirty when the scroll offset changes).
    this.store.markAllDirty();
    this.requestPaint();
  }

  /** Scroll so visual line `line` sits ~mid-viewport, fetching its history. */
  private revealLine(line: number): void {
    const s = this.store;
    const screenStart = s.maxScrollOffset(); // = totalLines - rows
    const targetRow = Math.floor(s.rows / 2);
    s.setScrollOffset(screenStart + targetRow - line); // setScrollOffset clamps
    this.fetchVisible();
  }

  /** The link under the given canvas pixels, or null. OSC-8 hyperlinks emitted
   *  by the emulator take precedence over regex URL/path detection. Returned
   *  start/len are CELL cols (the host draws underlines from them). */
  linkAt(px: number, py: number): LinkMatch | null {
    const { col, row } = pixelToCell(px, py, this.metrics, this.store.cols, this.store.rows);
    const abs = this.store.absLineAt(row);
    const osc = this.store.linkAt(abs, col);
    if (osc) return { start: osc.start, len: osc.len, kind: 'url', value: osc.value };
    const m = this.store.lineMap(abs);
    const hit = findLink(detectLinks(m.text), colToIndex(m, col));
    if (!hit) return null;
    const startCol = indexToCol(m, hit.start);
    return { ...hit, start: startCol, len: indexToCol(m, hit.start + hit.len) - startCol };
  }

  /** Resize the grid. The resize frame (→ SIGWINCH) always goes out immediately.
   *  With `hold` (the default, i.e. a pane/window resize), painting is suppressed
   *  until the program's own repaint lands so the reflowed-but-unrepainted
   *  intermediate never reaches the screen; the store keeps applying every frame
   *  throughout. Pass `hold: false` when there is no frame worth holding (mount,
   *  renderer rebuild, font/padding change) — the commit then runs synchronously. */
  resize(cols: number, rows: number, opts: { hold?: boolean } = {}): void {
    this.transport.cancelAllFetches();
    this.store.clearPendingHistory();
    this.lastFetchReqId = 0;
    // Never delay SIGWINCH: the program needs its new size as early as possible.
    this.transport.resize(cols, rows);
    if (this.hold) this.clearResizeTimers(this.hold);
    if (opts.hold === false) {
      this.hold = null;
      this.applyResize(cols, rows);
      return;
    }
    const hold: ResizeHold = {
      cols,
      rows,
      sawSync: false,
      deadlineTimer: null,
      settleTimer: null,
    };
    this.hold = hold;
    hold.deadlineTimer = this.setTimer(() => {
      if (this.hold === hold) this.commitResize();
    }, RESIZE_HOLD_MS);
  }

  /** End the hold: size the canvas (host), the renderer, and repaint. Safe to
   *  call when no hold is active. */
  commitResize(): void {
    const h = this.hold;
    if (!h) return;
    this.clearResizeTimers(h);
    this.hold = null;
    this.applyResize(h.cols, h.rows);
  }

  private clearResizeTimers(h: ResizeHold): void {
    if (h.deadlineTimer != null) this.clearTimer(h.deadlineTimer);
    if (h.settleTimer != null) this.clearTimer(h.settleTimer);
  }

  private applyResize(cols: number, rows: number): void {
    this.onResizeCommit?.(cols, rows); // host resizes the canvas → clears it
    this.renderer.resize(cols, rows, 1);
    this.store.markAllDirty(); // the cleared canvas needs every row redrawn
    // Commit paint is synchronous: yielding to rAF after resizing the backing
    // store lets Chromium composite one cleared frame. Drop any pre-resize rAF.
    this.paintQueued = false;
    this.renderer.paint(this.store);
    this.onAfterPaint?.();
  }

  private snapToBottomOnInput(): void {
    if (!this.store.atBottom()) {
      this.store.scrollToBottom();
      this.requestPaint();
    }
  }

  dispose(opts: { disposeTransport?: boolean } = {}): void {
    if (this.hold) this.clearResizeTimers(this.hold);
    this.hold = null;
    this.stopAutoScroll();
    if (this.transport.onUpdate === this.handleTransportUpdate) this.transport.onUpdate = undefined;
    if (this.transport.onSearchResult === this.handleTransportSearchResult) {
      this.transport.onSearchResult = undefined;
    }
    if (opts.disposeTransport ?? true) this.transport.dispose();
    this.paintQueued = false;
    this.renderer.dispose();
  }
}
