import { describe, it, expect, vi } from 'vitest';
import { TerminalController } from './TerminalController';
import { GridStore } from './GridStore';
import { GridSession, type GridSocket } from './GridSession';
import type { TerminalRenderer } from './renderer';
import type { FontMetrics } from './renderer';
import type { SearchHighlight } from './renderer';
import type { SyncFrame, WireModes } from './gridProtocol';

const METRICS: FontMetrics = {
  cellWidth: 8,
  cellHeight: 16,
  baseline: 12,
  fontFamily: 'mono',
  fontSize: 14,
};

class FakeSocket implements GridSocket {
  binaryType = '';
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
}

class FakeRenderer implements TerminalRenderer {
  paints = 0;
  lastResize: [number, number, number] | null = null;
  resize(c: number, r: number, d: number) {
    this.lastResize = [c, r, d];
  }
  paint() {
    this.paints++;
  }
  setMetrics() {}
  setSelection: TerminalRenderer['setSelection'] = () => {};
  setSearchMatches?: (matches: SearchHighlight[] | null, current: number) => void;
  dispose() {}
}

const textCell = (ch: string) => ({
  cp: ch.codePointAt(0)!,
  fg: 0,
  bg: 0,
  flags: 0,
  width: 1,
});

const MODES = (over: Partial<WireModes> = {}): WireModes => ({
  mouseReporting: false,
  altScreen: false,
  appCursor: false,
  bracketedPaste: false,
  ...over,
});

function setup(modes: WireModes = MODES()) {
  let sock!: FakeSocket;
  const store = new GridStore();
  // seed a screen so cols/rows/modes are set
  const f: SyncFrame = {
    type: 'sync',
    rev: 1,
    cols: 10,
    rows: 4,
    cursor: [0, 0],
    altScreen: modes.altScreen,
    modes,
    totalLines: 100, // plenty of scrollback so local scroll has room
    runs: [],
  };
  store.applySync(f);
  const session = new GridSession('ws://x?proto=grid', store, () => {
    sock = new FakeSocket();
    return sock;
  });
  session.connect();
  const renderer = new FakeRenderer();
  const controller = new TerminalController({
    store,
    session,
    renderer,
    metrics: METRICS,
    schedule: (cb) => cb(), // synchronous
  });
  return { store, session, renderer, controller, sock };
}

const key = (over: {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}) => ({
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe('TerminalController', () => {
  it('sends named keys and reports them handled', () => {
    const { controller, sock } = setup();
    expect(controller.handleKeyDown(key({ key: 'ArrowUp' }))).toBe(true);
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
      type: 'key',
      key: 'ArrowUp',
      mods: { shift: false, alt: false, ctrl: false, meta: false },
    });
  });

  it('does not consume plain printable keys (text path) or app shortcuts', () => {
    const { controller, sock } = setup();
    expect(controller.handleKeyDown(key({ key: 'a' }))).toBe(false);
    expect(controller.handleKeyDown(key({ key: 'c', metaKey: true }))).toBe(false);
    expect(sock.sent.length).toBe(0);
  });

  it('routes committed text and paste', () => {
    const { controller, sock } = setup();
    controller.handleText('hi');
    controller.handlePaste('blob');
    expect(JSON.parse(sock.sent[0])).toEqual({ type: 'text', text: 'hi' });
    expect(JSON.parse(sock.sent[1])).toEqual({ type: 'paste', text: 'blob' });
  });

  it('suppresses keydown while IME is composing', () => {
    const { controller, sock } = setup();
    controller.ime.start();
    expect(controller.handleKeyDown(key({ key: 'ArrowUp' }))).toBe(false);
    expect(sock.sent.length).toBe(0);
  });

  it('IME commit sends text', () => {
    const { controller, sock } = setup();
    controller.ime.start();
    controller.ime.end('世界');
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: 'text', text: '世界' });
  });

  it('paints on session update', () => {
    const { session, renderer } = setup();
    session.onUpdate?.();
    expect(renderer.paints).toBe(1);
  });

  it('forwards mouse when reporting is on, else returns the cell for selection', () => {
    const on = setup(MODES({ mouseReporting: true }));
    expect(on.controller.handlePointer('down', 0, 20, 33)).toBeNull();
    expect(JSON.parse(on.sock.sent.at(-1)!)).toMatchObject({ type: 'mouse', col: 2, row: 2 });

    const off = setup();
    expect(off.controller.handlePointer('down', 0, 20, 33)).toEqual({ col: 2, row: 2 });
  });

  it('wheel scrolls locally when mouse reporting is off (normal screen)', () => {
    const { controller, store } = setup();
    controller.handleWheel(3, 0, 0); // scroll up 3 rows
    expect(store.scrollOffset).toBe(3);
  });

  it('wheel scrollback is sub-line continuous: position tracks, content snaps', () => {
    const { controller, store } = setup();
    controller.handleWheel(0.4, 0, 0); // less than half a row up
    expect(store.scrollPos).toBeCloseTo(0.4); // continuous position moved
    expect(store.scrollOffset).toBe(0); // content row still snapped to the tail
    controller.handleWheel(0.4, 0, 0); // crosses the half-row → content advances
    expect(store.scrollPos).toBeCloseTo(0.8);
    expect(store.scrollOffset).toBe(1);
  });

  it('continuous wheel only repaints/fetches when the content row changes', () => {
    const { controller, renderer, sock } = setup();
    const fetches = () => sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'fetch');
    controller.handleWheel(0.3, 0, 0); // sub-line: scrollbar moves, no row change
    expect(renderer.paints).toBe(0);
    expect(fetches().length).toBe(0);
    controller.handleWheel(2, 0, 0); // 2.3 → rounds to row 2 → paint + fetch
    expect(renderer.paints).toBeGreaterThan(0);
    expect(fetches().length).toBe(1);
  });

  it('wheel forwards as mouse wheel events when mouse reporting is on', () => {
    const { controller, sock } = setup(MODES({ mouseReporting: true, altScreen: true }));
    controller.handleWheel(2, 8, 16); // pointer at col 1, row 1 (8px cells)
    const sent = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'mouse');
    expect(sent.length).toBe(2);
    expect(sent[0]).toMatchObject({ type: 'mouse', action: 'wheelUp', col: 1, row: 1 });
  });

  it('wheel sends arrow keys in alt-screen without mouse reporting', () => {
    const { controller, sock } = setup(MODES({ altScreen: true }));
    controller.handleWheel(-2, 0, 0); // scroll down
    const keys = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'key');
    expect(keys.length).toBe(2);
    expect(keys[0]).toMatchObject({ type: 'key', key: 'ArrowDown' });
  });

  it('typing snaps back to the bottom when scrolled up', () => {
    const { controller, store } = setup();
    store.setScrollOffset(20);
    expect(store.atBottom()).toBe(false);
    controller.handleKeyDown(key({ key: 'Enter' }));
    expect(store.atBottom()).toBe(true);
  });

  it('builds a selection from drag pixels and copies the text', () => {
    const { controller, store } = setup();
    // seed two screen rows of text at the bottom
    store.applyDelta({
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES(),
      totalLines: 100,
      runs: [
        { line: 0, startCol: 0, cells: [...'hello'].map((c) => textCell(c)), wrapped: false },
        { line: 1, startCol: 0, cells: [...'world'].map((c) => textCell(c)), wrapped: false },
      ],
    });
    // drag from row0 col0 to row0 col3 (8px cells)
    controller.selectionStart(0, 0);
    controller.selectionUpdate(24, 0);
    expect(controller.hasSelection()).toBe(true);
    expect(controller.copySelection()).toBe('hel');
    // clearing on input
    controller.handleText('x');
    expect(controller.hasSelection()).toBe(false);
  });

  it('copySelection joins soft-wrapped rows without a newline', () => {
    const { controller, store } = setup();
    // Seed two visual rows where row 0 wraps into row 1 (logical line continues)
    store.applyDelta({
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES(),
      totalLines: 100,
      runs: [
        { line: 0, startCol: 0, cells: [...'hello'].map((c) => textCell(c)), wrapped: true },
        { line: 1, startCol: 0, cells: [...'world'].map((c) => textCell(c)), wrapped: false },
      ],
    });
    // Select from the start of row 0 to the end of row 1 (all 5 chars on row 1)
    // rows are at the bottom of a 4-row screen with totalLines=100 → screen top = abs 96
    // row 0 of screen = abs 96, row 1 = abs 97
    controller.selectionStart(0, 0);        // row 0 col 0
    controller.selectionUpdate(5 * 8, 16);  // row 1 col 5 (end of "world")
    expect(controller.hasSelection()).toBe(true);
    // wrapped: no newline between row 0 and row 1
    expect(controller.copySelection()).toBe('helloworld');
  });

  it('copySelection inserts a newline between non-wrapped rows', () => {
    const { controller, store } = setup();
    store.applyDelta({
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES(),
      totalLines: 100,
      runs: [
        { line: 0, startCol: 0, cells: [...'hello'].map((c) => textCell(c)), wrapped: false },
        { line: 1, startCol: 0, cells: [...'world'].map((c) => textCell(c)), wrapped: false },
      ],
    });
    controller.selectionStart(0, 0);
    controller.selectionUpdate(5 * 8, 16);
    expect(controller.hasSelection()).toBe(true);
    expect(controller.copySelection()).toBe('hello\nworld');
  });

  it('detects a URL link under the pointer', () => {
    const { controller, store } = setup();
    store.applyDelta({
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES(),
      totalLines: 100,
      // cols is 10 in this setup — keep the URL within the row.
      runs: [{ line: 0, startCol: 0, cells: [...'a http://x'].map((c) => textCell(c)), wrapped: false }],
    });
    const link = controller.linkAt(8 * 4, 0); // col 4 → inside "http://x"
    expect(link?.kind).toBe('url');
    expect(link?.value).toBe('http://x');
    expect(controller.linkAt(0, 0)).toBeNull(); // col 0 → "a"
  });

  it('detects links at the right cells after a wide char', () => {
    const { controller, store } = setup();
    store.applySync({
      type: 'sync', rev: 2, cols: 14, rows: 4, cursor: [0, 0], altScreen: false,
      modes: MODES(), totalLines: 100,
      runs: [{ line: 0, startCol: 0, cells: [wideCell('世'), textCell(' '), ...[...'http://x'].map((c) => textCell(c))], wrapped: false }],
    });
    const link = controller.linkAt(4 * 8, 0);
    expect(link?.value).toBe('http://x');
    expect(link?.start).toBe(3); // CELL col of 'h', not string index 2
    expect(link?.len).toBe(8);
  });

  it('cancels the prior in-flight fetch when a new fetch supersedes it', () => {
    // rows=4, totalLines=100 → scrollbackEnd=96
    // Scroll to 3: fetches range [77,96), reqId=A; rows 77-95 marked pending.
    // Scroll to 50: range [30,58) has uncached rows not in pending → new fetch fires.
    // Expect: cancel(A) sent before the second fetch, second fetch has a new reqId.
    const { controller, sock } = setup();
    controller.handleWheel(3, 0, 0); // first scroll up → first fetch
    const fetchesBefore = sock.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'fetch');
    expect(fetchesBefore.length).toBe(1);
    const firstReqId = fetchesBefore[0].reqId;

    // Big scroll so the new range has uncached rows outside the first pending range.
    controller.handleWheel(47, 0, 0); // now at offset 50
    const all = sock.sent.map((s) => JSON.parse(s));
    const cancels = all.filter((m) => m.type === 'cancel');
    const fetches = all.filter((m) => m.type === 'fetch');
    expect(cancels.length).toBe(1);
    expect(cancels[0].reqId).toBe(firstReqId);
    expect(fetches.length).toBe(2);
    expect(fetches[1].reqId).not.toBe(firstReqId);
  });

  it('supersede-cancel frees pending rows so they are re-fetchable', () => {
    // Sequence: scroll up → fetch reqId=A pins rows [77,96) in pendingHistory.
    // Big scroll far enough that the second fetch range is entirely outside [77,96)
    // so the second fetch only fires because missingHistory reports those rows.
    // After the cancel+clear the previously-pending rows [77,96) should no longer
    // be pinned — a subsequent fetchVisible covering that range must issue a fresh
    // fetch rather than a no-op.
    const { controller, sock, store } = setup();

    // First scroll: offset=3 → fetch [77,96), rows marked pending.
    controller.handleWheel(3, 0, 0);
    const f1 = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'fetch');
    expect(f1.length).toBe(1);
    const firstReqId = f1[0].reqId;

    // Verify rows are pending (missingHistory returns empty for that range).
    expect(store.missingHistory(77, 96).length).toBe(0);

    // Big scroll: offset=50 → supersedes; cancel(firstReqId) + clearPendingHistory
    // fires, then new fetch for [30,58) (or similar uncached range).
    controller.handleWheel(47, 0, 0);
    const all = sock.sent.map((s) => JSON.parse(s));
    const cancels = all.filter((m) => m.type === 'cancel');
    expect(cancels.length).toBe(1);
    expect(cancels[0].reqId).toBe(firstReqId);

    // After supersede, rows 77-95 must no longer be pinned as pending.
    // missingHistory must report them as missing again (re-fetchable).
    expect(store.missingHistory(77, 96).length).toBeGreaterThan(0);

    // Scrolling back to offset=3 must issue a new fetch for those rows.
    // Scroll down a lot first to clear prevOffset tracking, then back up.
    controller.handleWheel(-50, 0, 0); // back to bottom
    controller.handleWheel(3, 0, 0);   // back to offset=3
    const fetches = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'fetch');
    // Must have more than 2 fetches (the third scroll-up issues a fresh one).
    expect(fetches.length).toBeGreaterThan(2);
    const lastFetch = fetches.at(-1)!;
    expect(lastFetch.reqId).not.toBe(firstReqId);
    // The fresh fetch must reach into the previously-cancelled range.
    expect(lastFetch.to).toBeGreaterThan(77);
  });

  it('resize cancels in-flight fetches and clears pending history', () => {
    const { controller, sock, store } = setup();
    controller.handleWheel(3, 0, 0); // in-flight fetch
    const beforeFetches = sock.sent.filter((s) => JSON.parse(s).type === 'fetch').length;
    expect(beforeFetches).toBe(1);
    // Mark some pending rows so we can verify they're cleared.
    const missingBefore = store.missingHistory(77, 96);
    expect(missingBefore.length).toBe(0); // all pending after the fetch
    controller.resize(80, 4);
    // After resize the pending set is cleared — rows should be re-fetchable.
    const missingAfter = store.missingHistory(77, 96);
    expect(missingAfter.length).toBeGreaterThan(0);
    const cancels = sock.sent.filter((s) => JSON.parse(s).type === 'cancel');
    expect(cancels.length).toBe(1);
  });

  it('does not re-request history while a fetch is already in flight', () => {
    const { controller, session, sock } = setup();
    controller.handleWheel(3, 0, 0); // scroll into history → one fetch
    const fetches = () => sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'fetch');
    expect(fetches().length).toBe(1);
    // Every applied frame triggers onUpdate → fetchVisible. Before the requested
    // rows arrive, this must NOT spawn duplicate fetches for the same range
    // (the feedback loop that saturated inflight at ~250 and ballooned rtt).
    for (let i = 0; i < 50; i++) session.onUpdate?.();
    expect(fetches().length).toBe(1);
  });

  it('warms the cache above the live tail while following', () => {
    // rows=4, totalLines=100 → screen top is abs line 96. Prefetch 2 screenfuls
    // above it so the first scroll-up paints without a round-trip.
    const { session, sock } = setup();
    session.onUpdate?.();
    const fetches = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'fetch');
    expect(fetches.at(-1)).toMatchObject({ from: 88, to: 96 });
  });

  it('throttles tail prefetch even as output grows', () => {
    let t = 1000;
    const store = new GridStore();
    store.applySync({
      type: 'sync', rev: 1, cols: 10, rows: 4, cursor: [0, 0],
      altScreen: false, modes: MODES(), totalLines: 100, runs: [],
    });
    let sock!: FakeSocket;
    const session = new GridSession('ws://x', store, () => (sock = new FakeSocket()));
    session.connect();
    const controller = new TerminalController({
      store, session, renderer: new FakeRenderer(), metrics: METRICS,
      schedule: (cb) => cb(), clock: () => t,
    });
    void controller;
    const fetches = () => sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'fetch');
    session.onUpdate?.(); // fires
    store.applyDelta({ type: 'delta', rev: 2, cursor: [0, 0], modes: MODES(), totalLines: 120, runs: [] });
    session.onUpdate?.(); // same clock → throttled despite new missing rows
    expect(fetches().length).toBe(1);
    t += 200; // past the throttle window
    store.applyDelta({ type: 'delta', rev: 3, cursor: [0, 0], modes: MODES(), totalLines: 140, runs: [] });
    session.onUpdate?.(); // now allowed
    expect(fetches().length).toBe(2);
  });

  it('fetches a wider window with lookahead in the scroll direction', () => {
    // Scrolling up (into history): 2 screenfuls margin each side + 2 extra below
    // (older). rows=4 → from = 93 - 8 - 8 = 77, to clamps to scrollbackEnd 96.
    const { controller, sock } = setup();
    controller.handleWheel(3, 0, 0);
    const fetches = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'fetch');
    expect(fetches.at(-1)).toMatchObject({ from: 77, to: 96 });
  });

  it('clears the selection when a sync (possible reflow) arrives', () => {
    const { controller, store, session } = setup();
    store.applyDelta({
      type: 'delta', rev: 2, cursor: [0, 0], modes: MODES(), totalLines: 100,
      runs: [{ line: 0, startCol: 0, cells: [...'hello'].map((c) => textCell(c)), wrapped: false }],
    });
    controller.selectionStart(0, 0);
    controller.selectionUpdate(24, 0);
    expect(controller.hasSelection()).toBe(true);
    store.applySync({
      type: 'sync', rev: 3, cols: 10, rows: 4, cursor: [0, 0], altScreen: false,
      modes: MODES(), totalLines: 100, runs: [],
    });
    session.onUpdate?.(); // transport notifies after each applied frame
    expect(controller.hasSelection()).toBe(false);
  });

  it('resize tells both the renderer and the server', () => {
    const { controller, renderer, sock } = setup();
    controller.resize(100, 30);
    expect(renderer.lastResize).toEqual([100, 30, 1]);
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: 'resize', cols: 100, rows: 30 });
  });

  it('search sends a frame and applies matches on the matching result', () => {
    const { controller, session, sock, renderer } = setup();
    let captured: { matches: SearchHighlight[] | null; current: number } | null = null;
    renderer.setSearchMatches = (matches, current) => { captured = { matches, current }; };

    controller.search('foo', true);
    const frame = JSON.parse(sock.sent.at(-1)!);
    expect(frame).toMatchObject({ type: 'search', query: 'foo', caseSensitive: true });

    session.onSearchResult!({
      type: 'searchResult', reqId: frame.reqId, done: true,
      matches: [{ line: 10, col: 2, len: 3 }, { line: 11, col: 0, len: 3 }],
    });
    expect(controller.searchMatchCount).toBe(2);
    expect(captured!.matches!.length).toBe(2);
    expect(controller.searchActiveIndex).toBeGreaterThanOrEqual(0);
  });

  it('searchNext/Prev wrap around', () => {
    const { controller, session, sock } = setup();
    controller.search('x', false);
    const reqId = JSON.parse(sock.sent.at(-1)!).reqId;
    session.onSearchResult!({
      type: 'searchResult', reqId, done: true,
      matches: [{ line: 0, col: 0, len: 1 }, { line: 1, col: 0, len: 1 }, { line: 2, col: 0, len: 1 }],
    });
    const first = controller.searchActiveIndex; // 0 (no match >= viewport top 96)
    controller.searchPrev();
    expect(controller.searchActiveIndex).toBe((first + 2) % 3);
    controller.searchNext();
    controller.searchNext();
    expect(controller.searchActiveIndex).toBe((first + 1) % 3);
  });

  it('ignores stale search results', () => {
    const { controller, session, sock } = setup();
    controller.search('x', false);
    const reqId = JSON.parse(sock.sent.at(-1)!).reqId;
    session.onSearchResult!({
      type: 'searchResult', reqId: reqId + 1, done: true,
      matches: [{ line: 0, col: 0, len: 1 }],
    });
    expect(controller.searchMatchCount).toBe(0); // reqId mismatch → ignored
  });

  it('empty query clears search', () => {
    const { controller, renderer } = setup();
    let cleared = false;
    renderer.setSearchMatches = (m) => { if (m === null) cleared = true; };
    controller.search('', false);
    expect(cleared).toBe(true);
    expect(controller.searchMatchCount).toBe(0);
  });
});

describe('drag-selection auto-scroll', () => {
  /** Build a controller with injectable timer shims + history available. */
  function setupAutoScroll() {
    let tick: (() => void) | null = null;
    let autoScrollActive = false;
    const store = new GridStore();
    // Large totalLines so there's room to scroll in both directions.
    store.applySync({
      type: 'sync', rev: 1, cols: 10, rows: 4, cursor: [0, 0], altScreen: false,
      modes: MODES(), totalLines: 200, runs: [],
    });
    // Scroll to the middle so there's room to scroll both up and down.
    store.setScrollOffset(50);

    let sock!: FakeSocket;
    const session = new GridSession('ws://x?proto=grid', store, () => {
      sock = new FakeSocket();
      return sock;
    });
    session.connect();
    const renderer = new FakeRenderer();
    const controller = new TerminalController({
      store,
      session,
      renderer,
      metrics: METRICS,
      schedule: (cb) => cb(),
      setAutoScroll: (cb, _ms) => { tick = cb; autoScrollActive = true; return 1; },
      clearAutoScroll: (_h) => { autoScrollActive = false; tick = null; },
    });
    void sock;
    return { store, controller, renderer, tick: () => tick?.(), isActive: () => autoScrollActive };
  }

  it('starts auto-scroll loop when dragging above top edge (negative py)', () => {
    const { controller, store, tick, isActive } = setupAutoScroll();
    const startOffset = store.scrollOffset; // 50
    // Start selection at mid-viewport (row 2, col 0)
    controller.selectionStart(0, 2 * 16);
    // Drag to py = -16 (one row above top edge)
    controller.selectionUpdate(0, -16);
    expect(isActive()).toBe(true);
    // Fire one tick → scrollOffset should increase (scrolling toward history)
    tick();
    expect(store.scrollOffset).toBeGreaterThan(startOffset);
  });

  it('scroll step accelerates with distance past the edge', () => {
    const { controller, store, tick } = setupAutoScroll();
    // Reset to a mid-point with lots of room
    store.setScrollOffset(50);
    controller.selectionStart(0, 2 * 16);

    // Near edge: -16px (1 cellHeight above) → 1 row/tick
    controller.selectionUpdate(0, -16);
    const before1 = store.scrollOffset;
    tick();
    const step1 = store.scrollOffset - before1;
    expect(step1).toBeGreaterThanOrEqual(1);

    // Far edge: -300px (many cellHeights above) → larger step
    store.setScrollOffset(50);
    controller.selectionUpdate(0, -300);
    const before2 = store.scrollOffset;
    tick();
    const step2 = store.scrollOffset - before2;
    expect(step2).toBeGreaterThan(step1);
  });

  it('stops scrolling after selectionEnd', () => {
    const { controller, store, tick, isActive } = setupAutoScroll();
    store.setScrollOffset(50);
    controller.selectionStart(0, 2 * 16);
    controller.selectionUpdate(0, -16);
    expect(isActive()).toBe(true);
    controller.selectionEnd();
    expect(isActive()).toBe(false);
    const offsetAfterEnd = store.scrollOffset;
    tick(); // tick must not scroll further
    expect(store.scrollOffset).toBe(offsetAfterEnd);
  });

  it('stops loop when pointer returns inside viewport', () => {
    const { controller, isActive } = setupAutoScroll();
    controller.selectionStart(0, 2 * 16);
    controller.selectionUpdate(0, -16); // outside → loop starts
    expect(isActive()).toBe(true);
    controller.selectionUpdate(0, 32); // inside → loop stops
    expect(isActive()).toBe(false);
  });

  it('stops at the scroll extent (cannot over-scroll)', () => {
    const { controller, store, tick } = setupAutoScroll();
    // Scroll to the very top (max offset), then try to scroll further up.
    const maxOff = store.maxScrollOffset();
    store.setScrollOffset(maxOff);
    controller.selectionStart(0, 2 * 16);
    controller.selectionUpdate(0, -16); // above top edge
    tick(); // already at extent → stopAutoScroll called
    expect(store.scrollOffset).toBe(maxOff); // no further change
  });

  it('scrolls down when pointer is below bottom edge (positive overshoot)', () => {
    const { controller, store, tick } = setupAutoScroll();
    store.setScrollOffset(50);
    const startOffset = store.scrollOffset;
    const vh = store.rows * METRICS.cellHeight; // 4 * 16 = 64
    controller.selectionStart(0, 2 * 16);
    controller.selectionUpdate(0, vh + 16); // 16px below bottom edge
    tick();
    // Scrolling down = scrollOffset decreases (toward live tail)
    expect(store.scrollOffset).toBeLessThan(startOffset);
  });

  it('clearSelection stops the auto-scroll loop', () => {
    const { controller, isActive } = setupAutoScroll();
    controller.selectionStart(0, 2 * 16);
    controller.selectionUpdate(0, -16);
    expect(isActive()).toBe(true);
    controller.clearSelection();
    expect(isActive()).toBe(false);
  });
});

const wideCell = (ch: string) => ({ cp: ch.codePointAt(0)!, fg: 0, bg: 0, flags: 0, width: 2 });

describe('selection with wide chars', () => {
  function seedRow(cells: ReturnType<typeof textCell>[]) {
    const env = setup();
    env.store.applyDelta({
      type: 'delta', rev: 2, cursor: [0, 0], modes: MODES(), totalLines: 100,
      runs: [{ line: 0, startCol: 0, cells, wrapped: false }],
    });
    return env;
  }

  it('copies the right cells across CJK wide chars', () => {
    // 世(0-1) 界(2-3) a(4) b(5)
    const { controller } = seedRow([wideCell('世'), wideCell('界'), textCell('a'), textCell('b')]);
    controller.selectionStart(0, 0); // col 0
    controller.selectionUpdate(5 * 8, 0); // col 5 (exclusive end)
    expect(controller.copySelection()).toBe('世界a');
  });

  it('never splits an astral pair on copy', () => {
    // 😀(0-1) x(2)
    const { controller } = seedRow([wideCell('😀'), textCell('x')]);
    controller.selectionStart(2 * 8, 0); // col 2
    controller.selectionUpdate(3 * 8, 0); // col 3
    expect(controller.copySelection()).toBe('x'); // was the lone low surrogate
  });

  it('double-click selects the word cells after wide chars', () => {
    // 世(0-1) 界(2-3) ' '(4) f(5) o(6) o(7)
    const { controller, renderer } = seedRow([
      wideCell('世'), wideCell('界'), textCell(' '), textCell('f'), textCell('o'), textCell('o'),
    ]);
    let sel: { startCol: number; endCol: number } | null = null;
    renderer.setSelection = (s: { startCol: number; endCol: number } | null) => { sel = s; };
    controller.selectWordAt(5 * 8, 0); // click 'f' at col 5
    expect(controller.copySelection()).toBe('foo');
    expect(sel).toMatchObject({ startCol: 5, endCol: 8 }); // cell cols, not string idx
  });
});
