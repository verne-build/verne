import { describe, it, expect } from 'vitest';
import { GridStore, STICKY_THRESHOLD } from './GridStore';
import type { Cell, DeltaFrame, HistoryFrame, SyncFrame, WireModes } from './gridProtocol';

const MODES: WireModes = {
  mouseReporting: false,
  altScreen: false,
  appCursor: false,
  bracketedPaste: false,
};

const cell = (ch: string, width = 1): Cell => ({
  cp: ch.codePointAt(0)!,
  fg: 0,
  bg: 0,
  flags: 0,
  width,
});

const rowText = (cells: Cell[]) =>
  cells
    .filter((c) => c.width !== 0)
    .map((c) => String.fromCodePoint(c.cp))
    .join('');

function sync(over: Partial<SyncFrame> = {}): SyncFrame {
  return {
    type: 'sync',
    rev: 1,
    cols: 5,
    rows: 2,
    cursor: [0, 0],
    altScreen: false,
    modes: MODES,
    totalLines: 2,
    runs: [],
    ...over,
  };
}

describe('GridStore.applySync', () => {
  it('builds the screen, cursor, and marks all rows dirty', () => {
    const s = new GridStore();
    s.applySync(
      sync({
        cursor: [1, 2],
        runs: [{ line: 0, startCol: 0, cells: [cell('h'), cell('i')] , wrapped: false}],
      }),
    );
    expect(s.cols).toBe(5);
    expect(s.rows).toBe(2);
    expect(s.cursor).toEqual([1, 2]);
    expect(rowText(s.screen[0]).trimEnd()).toBe('hi'); // remaining cols are blanks (spaces)
    expect(s.screen[0].length).toBe(5);
    expect(s.dirtyRows.size).toBe(2);
  });

  it('expands a wide char into a cell + width-0 spacer', () => {
    const s = new GridStore();
    s.applySync(sync({ runs: [{ line: 0, startCol: 0, cells: [cell('世', 2), cell('x')] , wrapped: false}] }));
    expect(s.screen[0][0].cp).toBe('世'.codePointAt(0));
    expect(s.screen[0][1].width).toBe(0); // spacer
    expect(s.screen[0][2].cp).toBe('x'.codePointAt(0));
  });
});

describe('GridStore.linkAt', () => {
  const linked = (ch: string, link: string): Cell => ({ ...cell(ch), link });

  it('expands to the contiguous same-URI run and ignores plain cells', () => {
    const s = new GridStore();
    const uri = 'https://example.com';
    s.applySync(
      sync({
        runs: [{ line: 0, startCol: 0, cells: [cell('a'), linked('b', uri), linked('c', uri), cell('d')] , wrapped: false}],
      }),
    );
    expect(s.linkAt(0, 0)).toBeNull(); // 'a' has no link
    expect(s.linkAt(0, 1)).toEqual({ value: uri, start: 1, len: 2 });
    expect(s.linkAt(0, 2)).toEqual({ value: uri, start: 1, len: 2 }); // same run
    expect(s.linkAt(0, 3)).toBeNull(); // 'd' has no link
  });

  it('separates adjacent runs with different URIs', () => {
    const s = new GridStore();
    s.applySync(
      sync({
        runs: [{ line: 0, startCol: 0, cells: [linked('a', 'u1'), linked('b', 'u2')] , wrapped: false}],
      }),
    );
    expect(s.linkAt(0, 0)).toEqual({ value: 'u1', start: 0, len: 1 });
    expect(s.linkAt(0, 1)).toEqual({ value: 'u2', start: 1, len: 1 });
  });
});

describe('GridStore.applyDelta', () => {
  it('updates the targeted row and marks only it dirty', () => {
    const s = new GridStore();
    s.applySync(sync({ runs: [{ line: 0, startCol: 0, cells: [cell('a'), cell('b')] , wrapped: false}] }));
    s.clearDirty();
    const d: DeltaFrame = {
      type: 'delta',
      rev: 2,
      cursor: [1, 0],
      modes: MODES,
      totalLines: 3,
      runs: [{ line: 1, startCol: 2, cells: [cell('Z')] , wrapped: false}],
    };
    s.applyDelta(d);
    expect(s.rev).toBe(2);
    expect(s.cursor).toEqual([1, 0]);
    expect(s.screen[1][2].cp).toBe('Z'.codePointAt(0));
    expect([...s.dirtyRows]).toEqual([1]);
  });
});

describe('GridStore scroll follow/freeze', () => {
  it('follows at bottom and within the stickiness threshold', () => {
    const s = new GridStore();
    s.applySync(sync({ totalLines: 20 })); // 18 rows of scrollback, rows=2
    expect(s.atBottom()).toBe(true);
    s.setScrollOffset(STICKY_THRESHOLD);
    expect(s.atBottom()).toBe(true);
    s.setScrollOffset(STICKY_THRESHOLD + 1);
    expect(s.atBottom()).toBe(false);
  });

  it('clamps the scroll offset to available history', () => {
    const s = new GridStore();
    s.applySync(sync({ totalLines: 5 })); // rows=2 → max offset 3
    s.setScrollOffset(999);
    expect(s.scrollOffset).toBe(3);
    expect(s.maxScrollOffset()).toBe(3);
  });

  it('flags new output only while frozen, cleared by scrollToBottom', () => {
    const s = new GridStore();
    s.applySync(sync({ totalLines: 20 }));
    const d: DeltaFrame = {
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES,
      totalLines: 21,
      runs: [{ line: 0, startCol: 0, cells: [cell('x')] , wrapped: false}],
    };
    // following → no pill
    s.applyDelta(d);
    expect(s.hasNewOutputWhileScrolled).toBe(false);
    // frozen → pill
    s.setScrollOffset(10);
    s.applyDelta({ ...d, rev: 3, totalLines: 22 });
    expect(s.hasNewOutputWhileScrolled).toBe(true);
    // back to bottom clears it
    s.scrollToBottom();
    expect(s.scrollOffset).toBe(0);
    expect(s.hasNewOutputWhileScrolled).toBe(false);
  });

  it('snaps a sticky-band offset back to 0 when a delta arrives', () => {
    const s = new GridStore();
    s.applySync(sync({ totalLines: 20 })); // rows=2 → plenty of scrollback
    s.setScrollOffset(STICKY_THRESHOLD); // within the band → still "at bottom"
    s.clearDirty();
    s.applyDelta({
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES,
      totalLines: 21,
      runs: [{ line: 1, startCol: 0, cells: [cell('x')] , wrapped: false}],
    });
    expect(s.scrollOffset).toBe(0); // rejoined the tail exactly
    expect(s.dirtyRows.has(1)).toBe(true);
    expect(s.dirtyRows.size).toBe(s.rows); // window shifted by 1 → full repaint
  });

  it('re-anchors a frozen view as new rows push into scrollback', () => {
    const s = new GridStore();
    s.applySync(sync({ totalLines: 20 }));
    s.setScrollOffset(10);
    const grew: DeltaFrame = {
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES,
      totalLines: 23, // +3 rows
      runs: [{ line: 0, startCol: 0, cells: [cell('x')] , wrapped: false}],
    };
    s.applyDelta(grew);
    expect(s.scrollOffset).toBe(13); // stays anchored on the same content
  });

  it('re-anchors a frozen view when scrollback evicts (base advances, total pinned)', () => {
    const s = new GridStore();
    // Saturated buffer: totalLines is pinned at the cap.
    s.applySync(sync({ totalLines: 100, base: 0 }));
    s.setScrollOffset(10);
    // 5 rows evicted off the top; total unchanged, but content shifted down.
    const evict: DeltaFrame = {
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES,
      totalLines: 100,
      base: 5,
      runs: [{ line: 0, startCol: 0, cells: [cell('x')] , wrapped: false}],
    };
    s.applyDelta(evict);
    // Bumped by the eviction count so the same content stays under the viewport.
    expect(s.scrollOffset).toBe(15);
  });

  it('keeps cached history valid across eviction by keying on stable id', () => {
    const s = new GridStore();
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 100, base: 0 }));
    // Cache the row at visual index 40 (stable id 40 while base is 0).
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 40,
      to: 41,
      base: 0,
      runs: [{ line: 40, startCol: 0, cells: [cell('A'), cell('B')] , wrapped: false}],
    });
    // 5 rows evicted; the same content now lives at visual index 35.
    s.applyDelta({
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES,
      totalLines: 100,
      base: 5,
      runs: [],
    });
    expect(rowText(s.lineCells(35)).trimEnd()).toBe('AB');
  });
});

describe('GridStore visible rows', () => {
  it('maps render rows to live screen at the bottom, history when scrolled', () => {
    const s = new GridStore();
    // rows=2, 4 rows of scrollback (totalLines 6).
    s.applySync(
      sync({
        rows: 2,
        totalLines: 6,
        runs: [
          { line: 0, startCol: 0, cells: [cell('L'), cell('0')] , wrapped: false},
          { line: 1, startCol: 0, cells: [cell('L'), cell('1')] , wrapped: false},
        ],
      }),
    );
    // At bottom: render rows are the live screen.
    expect(rowText(s.visibleRow(0)).trimEnd()).toBe('L0');
    expect(rowText(s.visibleRow(1)).trimEnd()).toBe('L1');
    // Provide history rows 0..3 and scroll up by 2.
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 0,
      to: 4,
      runs: [
        { line: 0, startCol: 0, cells: [cell('h'), cell('0')] , wrapped: false},
        { line: 1, startCol: 0, cells: [cell('h'), cell('1')] , wrapped: false},
        { line: 2, startCol: 0, cells: [cell('h'), cell('2')] , wrapped: false},
        { line: 3, startCol: 0, cells: [cell('h'), cell('3')] , wrapped: false},
      ],
    });
    s.setScrollOffset(2); // window now starts at absolute line 2
    expect(rowText(s.visibleRow(0)).trimEnd()).toBe('h2');
    expect(rowText(s.visibleRow(1)).trimEnd()).toBe('h3');
    expect(s.absLineAt(0)).toBe(2);
  });
});

describe('GridStore.lineMap', () => {
  it('maps cell cols to string indices across wide chars', () => {
    const s = new GridStore();
    // 世(cols 0-1) 界(cols 2-3) space(4) f(5) o(6) o(7)
    s.applySync(
      sync({
        cols: 10,
        runs: [
          {
            line: 0,
            startCol: 0,
            cells: [cell('世', 2), cell('界', 2), cell(' '), cell('f'), cell('o'), cell('o')],
            wrapped: false,
          },
        ],
      }),
    );
    const m = s.lineMap(0);
    expect(m.text).toBe('世界 foo');
    expect(m.colToIdx[0]).toBe(0); // 世 starts the string
    expect(m.colToIdx[1]).toBe(1); // spacer maps past 世
    expect(m.colToIdx[2]).toBe(1); // 界
    expect(m.colToIdx[5]).toBe(3); // f
    expect(m.idxToCol[3]).toBe(5); // f's col
    expect(m.idxToCol[m.text.length]).toBe(8); // sentinel: col past last cell
  });

  it('maps astral code points as multi-unit UTF-16 spans', () => {
    const s = new GridStore();
    // 😀 (cols 0-1, 2 UTF-16 units), x (col 2)
    s.applySync(
      sync({ cols: 5, runs: [{ line: 0, startCol: 0, cells: [cell('😀', 2), cell('x')] , wrapped: false}] }),
    );
    const m = s.lineMap(0);
    expect(m.text).toBe('😀x');
    expect(m.colToIdx[0]).toBe(0);
    expect(m.colToIdx[2]).toBe(2); // x starts AFTER both surrogate units
    expect(m.idxToCol[0]).toBe(0);
    expect(m.idxToCol[1]).toBe(0); // low surrogate still owned by col 0
    expect(m.idxToCol[2]).toBe(2);
  });

  it('clamps cols in trailing blanks to the trimmed length', () => {
    const s = new GridStore();
    s.applySync(sync({ cols: 5, runs: [{ line: 0, startCol: 0, cells: [cell('a')] , wrapped: false}] }));
    const m = s.lineMap(0);
    expect(m.text).toBe('a');
    expect(m.colToIdx[4]).toBe(1); // blank col → end of trimmed text
  });
});

describe('GridStore history cache (LRU)', () => {
  it('caches history rows and reports missing ranges', () => {
    const s = new GridStore(100);
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 })); // set cols for padding
    const h: HistoryFrame = {
      type: 'history',
      reqId: 1,
      from: 10,
      to: 12,
      runs: [
        { line: 10, startCol: 0, cells: [cell('a')] , wrapped: false},
        { line: 11, startCol: 0, cells: [cell('b')] , wrapped: false},
      ],
    };
    s.applyHistory(h);
    expect(s.hasHistory(10)).toBe(true);
    expect(rowText(s.getHistory(11)!).trimEnd()).toBe('b');
    expect(s.missingHistory(9, 13)).toEqual([9, 12]);
  });

  it('evicts least-recently-used lines past the limit', () => {
    const s = new GridStore(2);
    const put = (line: number, ch: string): HistoryFrame => ({
      type: 'history',
      reqId: 0,
      from: line,
      to: line + 1,
      runs: [{ line, startCol: 0, cells: [cell(ch)], wrapped: false }],
    });
    s.applyHistory(put(1, 'a'));
    s.applyHistory(put(2, 'b'));
    s.getHistory(1); // touch 1 → 2 is now LRU
    s.applyHistory(put(3, 'c')); // evicts 2
    expect(s.hasHistory(1)).toBe(true);
    expect(s.hasHistory(3)).toBe(true);
    expect(s.hasHistory(2)).toBe(false);
    expect(s.cachedHistoryCount).toBe(2);
  });

  it('excludes in-flight requested rows from missingHistory until they arrive', () => {
    const s = new GridStore(100);
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 }));
    expect(s.missingHistory(10, 13)).toEqual([10, 11, 12]);
    s.markHistoryRequested(10, 13); // request is now on the wire
    expect(s.missingHistory(10, 13)).toEqual([]); // → not re-fetched while pending
    // the response for that range clears it from pending; delivered rows cache,
    // any undelivered in-range rows become eligible again (no permanent block).
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 10,
      to: 13,
      runs: [{ line: 10, startCol: 0, cells: [cell('a')] , wrapped: false}],
    });
    expect(s.missingHistory(10, 13)).toEqual([11, 12]);
  });

  it('clears pending requests on resync', () => {
    const s = new GridStore(100);
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 }));
    s.markHistoryRequested(10, 13);
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 })); // resync drops in-flight state
    expect(s.missingHistory(10, 13)).toEqual([10, 11, 12]);
  });

  it('keeps cached history on a same-width resync (no reflow)', () => {
    const s = new GridStore(100);
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 }));
    s.applyHistory({
      type: 'history', reqId: 1, from: 10, to: 11,
      runs: [{ line: 10, startCol: 0, cells: [cell('a')] , wrapped: false}],
    });
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 })); // reconnect resync
    expect(s.hasHistory(10)).toBe(true);
  });

  it('clearPendingHistory frees pinned rows for re-request', () => {
    const s = new GridStore();
    s.applySync(sync({ cols: 5, rows: 2, totalLines: 20 }));
    s.markHistoryRequested(0, 5); // rows 0-4 now pending
    expect(s.missingHistory(0, 5)).toHaveLength(0); // all pending → not "missing"
    s.clearPendingHistory();
    expect(s.missingHistory(0, 5)).toHaveLength(5); // freed → all missing again
  });

  it('drops cached history on resync so stale-width rows are not served', () => {
    // Reflow on resize remaps visual indices + changes totalLines; rows cached
    // at the old width must be invalidated or they render alongside fresh,
    // re-wrapped rows (the duplicated-scrollback bug).
    const s = new GridStore(100);
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 }));
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 10,
      to: 11,
      runs: [{ line: 10, startCol: 0, cells: [cell('a')] , wrapped: false}],
    });
    expect(s.hasHistory(10)).toBe(true);
    s.applySync(sync({ cols: 8, rows: 1, totalLines: 80 })); // resize → reflow
    expect(s.hasHistory(10)).toBe(false);
    expect(s.cachedHistoryCount).toBe(0);
    expect(s.missingHistory(10, 11)).toEqual([10]); // re-fetched fresh at new width
  });
});

describe('GridStore.isWrapped', () => {
  it('applySync sets screenWrapped from run.wrapped', () => {
    const s = new GridStore();
    s.applySync(sync({
      rows: 3,
      totalLines: 3,
      runs: [
        { line: 0, startCol: 0, cells: [cell('a')], wrapped: true },
        { line: 1, startCol: 0, cells: [cell('b')], wrapped: false },
        { line: 2, startCol: 0, cells: [cell('c')], wrapped: true },
      ],
    }));
    expect(s.isWrapped(0)).toBe(true);
    expect(s.isWrapped(1)).toBe(false);
    expect(s.isWrapped(2)).toBe(true);
  });

  it('applyDelta updates screenWrapped for changed rows', () => {
    const s = new GridStore();
    s.applySync(sync({ rows: 2, totalLines: 2, runs: [] }));
    const d: DeltaFrame = {
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES,
      totalLines: 2,
      runs: [
        { line: 0, startCol: 0, cells: [cell('x')], wrapped: true },
        { line: 1, startCol: 0, cells: [cell('y')], wrapped: false },
      ],
    };
    s.applyDelta(d);
    expect(s.isWrapped(0)).toBe(true);
    expect(s.isWrapped(1)).toBe(false);
  });

  it('applyHistory caches wrap bits for history lines', () => {
    const s = new GridStore(100);
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 100, base: 0 }));
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 40,
      to: 42,
      base: 0,
      runs: [
        { line: 40, startCol: 0, cells: [cell('A')], wrapped: true },
        { line: 41, startCol: 0, cells: [cell('B')], wrapped: false },
      ],
    });
    expect(s.isWrapped(40)).toBe(true);
    expect(s.isWrapped(41)).toBe(false);
  });

  it('width-change resync clears historyWrapped', () => {
    const s = new GridStore(100);
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 }));
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 10,
      to: 11,
      base: 0,
      runs: [{ line: 10, startCol: 0, cells: [cell('a')], wrapped: true }],
    });
    expect(s.isWrapped(10)).toBe(true);
    s.applySync(sync({ cols: 8, rows: 1, totalLines: 80 })); // resize → reflow
    expect(s.isWrapped(10)).toBe(false); // cleared
  });

  it('eviction drops the wrap entry from historyWrapped', () => {
    const s = new GridStore(2); // limit 2
    const put = (line: number, wrapped: boolean): HistoryFrame => ({
      type: 'history',
      reqId: 0,
      from: line,
      to: line + 1,
      runs: [{ line, startCol: 0, cells: [cell('x')], wrapped }],
    });
    s.applySync(sync({ cols: 5, rows: 1, totalLines: 100 }));
    s.applyHistory(put(1, true));
    s.applyHistory(put(2, false));
    s.getHistory(1); // touch 1 → 2 is LRU
    s.applyHistory(put(3, true)); // evicts 2
    expect(s.isWrapped(1)).toBe(true); // still cached
    expect(s.isWrapped(2)).toBe(false); // evicted → defaults to false
    expect(s.isWrapped(3)).toBe(true);
  });

  it('isWrapped uses stable id (base+abs) for history — survives scrollback eviction', () => {
    // Regression: bare `abs` key coincides with stable id only when base===0.
    // After eviction (base>0) the lookup must use base+abs so it matches
    // applyHistory's frameBase+run.line key. Without the fix this returns false.
    const s = new GridStore(100);
    // totalLines=50, rows=1 → screenStart=49, so abs<49 is history.
    // base=10: stable id for visual index 35 is 10+35=45.
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 50, base: 10 }));
    // Cache a wrapped row: frameBase=10, run.line=35 → stored at key 45.
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 35,
      to: 36,
      base: 10,
      runs: [{ line: 35, startCol: 0, cells: [cell('W')], wrapped: true }],
    });
    // With the old bare-abs key: historyWrapped.get(35) → undefined → false (bug).
    // With the fix: historyWrapped.get(10+35=45) → true (correct).
    expect(s.isWrapped(35)).toBe(true);
  });
});

describe('GridStore scrollback clear (ESC[3J / reset)', () => {
  // `clear` purges scrollback on the server (history_size → ~screen) while base
  // stays flat, so produced (base+totalLines) DROPS. The server forces a sync;
  // the client must drop its now-stale history cache and shrink the extent.
  it('drops stale history cache when produced shrinks on a resync', () => {
    const s = new GridStore();
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 100, base: 0 }));
    // Cache a scrollback row (stable id 40 while base is 0).
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 40,
      to: 41,
      base: 0,
      runs: [{ line: 40, startCol: 0, cells: [cell('A'), cell('B')], wrapped: false }],
    });
    expect(s.cachedHistoryCount).toBe(1);
    // `clear`: scrollback wiped, base unchanged, produced 100 → 1. Arrives as a
    // forced sync (same width).
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 1, base: 0, rev: 2 }));
    expect(s.cachedHistoryCount).toBe(0);
    expect(s.maxScrollOffset()).toBe(0); // extent collapsed to the live screen
  });

  it('drops stale cache on a shrinking DELTA while at the bottom (the real clear flow)', () => {
    // `clear` arrives as a forced full delta, NOT a sync, and the user is at the
    // bottom (typed at the prompt). The cache-clear must still fire.
    const s = new GridStore();
    s.applySync(sync({ cols: 2, rows: 2, totalLines: 100, base: 0 }));
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 40,
      to: 41,
      base: 0,
      runs: [{ line: 40, startCol: 0, cells: [cell('A'), cell('B')], wrapped: false }],
    });
    expect(s.cachedHistoryCount).toBe(1);
    expect(s.atBottom()).toBe(true);
    // Server zeroed scrollback: total 100 → 2 (== rows), base flat, full frame.
    s.applyDelta({
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: MODES,
      totalLines: 2,
      base: 0,
      runs: [],
    });
    expect(s.cachedHistoryCount).toBe(0); // stale rows dropped despite atBottom
    expect(s.maxScrollOffset()).toBe(0); // can't scroll up — scrollback gone
  });

  it('keeps the cache on a same-width, non-shrinking resync (no refetch storm)', () => {
    const s = new GridStore();
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 100, base: 0 }));
    s.applyHistory({
      type: 'history',
      reqId: 1,
      from: 40,
      to: 41,
      base: 0,
      runs: [{ line: 40, startCol: 0, cells: [cell('A'), cell('B')], wrapped: false }],
    });
    // Reconnect resync at the same width and unchanged extent.
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 100, base: 0, rev: 2 }));
    expect(s.cachedHistoryCount).toBe(1);
  });

  it('re-clamps a frozen scroll position when the extent shrinks', () => {
    const s = new GridStore();
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 100, base: 0 }));
    s.setScrollOffset(50); // scrolled up into history (frozen)
    expect(s.scrollOffset).toBe(50);
    s.applySync(sync({ cols: 2, rows: 1, totalLines: 1, base: 0, rev: 2 }));
    expect(s.scrollOffset).toBe(0); // clamped to the new (empty) extent
  });
});
