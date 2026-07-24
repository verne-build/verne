import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  decodeArchivedSnapshot,
  gridStoreFromArchivedSnapshot,
  validateArchivedSnapshot,
  isCurrentArchivedRead,
} from './archivedSnapshot';
import type { ArchivedSnapshotBlob, GridSnapshotDump, GridSnapshotRow } from '../../types/shared';

const cell = (ch: string, width = 1) => ({ cp: ch.codePointAt(0)!, fg: 0, bg: 0, flags: 0, width });
const wide = (ch: string) => cell(ch, 2);

const textRow = (line: number, text: string, wrapped = false): GridSnapshotRow => ({
  line,
  startCol: 0,
  wrapped,
  cells: [...text].map((c) => cell(c)),
});

/** rows=2, three history rows (one wrapped, one with a wide cell), two viewport
 *  rows, cursorShape "block" in the dump (forced hidden on replay). */
function fixture(): GridSnapshotDump {
  return {
    cols: 10,
    rows: 2,
    cursorRow: 1,
    cursorCol: 0,
    totalLines: 5, // 3 history + 2 viewport
    base: 0,
    cursorShape: 'block',
    cursorBlink: true,
    modes: {
      mouseReporting: false,
      mouseDrag: false,
      mouseMotion: false,
      altScreen: false,
      appCursor: false,
      bracketedPaste: false,
    },
    historyRows: [
      textRow(0, 'oldest'),
      textRow(1, 'mid', true), // wrapped history row
      { line: 2, startCol: 0, wrapped: false, cells: [wide('世'), cell('x')] },
    ],
    viewport: [textRow(0, 'head'), textRow(1, 'tail')],
  };
}

function blobOf(dump: GridSnapshotDump, over: Partial<ArchivedSnapshotBlob> = {}): ArchivedSnapshotBlob {
  return {
    cols: dump.cols,
    rows: dump.rows,
    cursorRow: dump.cursorRow,
    cursorCol: dump.cursorCol,
    capturedAt: 1000,
    payload: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(dump)))),
    ...over,
  };
}

describe('decodeArchivedSnapshot', () => {
  it('decompresses + parses a valid blob into the DTO', async () => {
    const dump = fixture();
    const decoded = await decodeArchivedSnapshot(blobOf(dump));
    expect(decoded.cols).toBe(10);
    expect(decoded.historyRows.length).toBe(3);
    expect(decoded.viewport.length).toBe(2);
  });

  it('throws archived snapshot unavailable on malformed gzip', async () => {
    const blob = blobOf(fixture(), { payload: new Uint8Array([1, 2, 3, 4, 5]) });
    await expect(decodeArchivedSnapshot(blob)).rejects.toThrow('archived snapshot unavailable');
  });

  it('throws on invalid JSON inside the gzip', async () => {
    const blob = blobOf(fixture(), { payload: new Uint8Array(gzipSync(Buffer.from('not json{'))) });
    await expect(decodeArchivedSnapshot(blob)).rejects.toThrow('archived snapshot unavailable');
  });

  it('throws when blob header dims mismatch the dump', async () => {
    const blob = blobOf(fixture(), { cols: 99 });
    await expect(decodeArchivedSnapshot(blob)).rejects.toThrow('archived snapshot unavailable');
  });
});

describe('gridStoreFromArchivedSnapshot', () => {
  it('seeds a store via the sync + history frame path', () => {
    const store = gridStoreFromArchivedSnapshot(fixture());
    expect(store.totalLines).toBe(5);
    expect(store.cachedHistoryCount).toBe(3);
    expect(store.lineText(0)).toBe('oldest');
    expect(store.lineText(4)).toBe('tail');
    expect(store.isWrapped(1)).toBe(true);
    expect(store.cursorShape).toBe('hidden');
  });

  it('round-trips a real daemon-shaped dump: history_len >= 1, viewport screen-relative', () => {
    // Mirrors terminal_emulator.rs snapshot_dump() output for a session with
    // scrollback: historyRows keyed 0..history_len (absolute-in-history), viewport
    // keyed 0..rows (screen-relative) — NOT offset by history_len. Regression
    // guard for the daemon/renderer line-index contract (viewport.line ∈ [0, rows)).
    const rows = 3;
    const historyRows = [textRow(0, 'h0'), textRow(1, 'h1'), textRow(2, 'h2', true)];
    const viewport = [textRow(0, 'v0'), textRow(1, 'v1'), textRow(2, 'v2')];
    const dump: GridSnapshotDump = {
      ...fixture(),
      rows,
      totalLines: historyRows.length + rows,
      historyRows,
      viewport,
    };
    expect(() => validateArchivedSnapshot(dump)).not.toThrow();

    const store = gridStoreFromArchivedSnapshot(dump);
    expect(store.totalLines).toBe(historyRows.length + rows);
    expect(store.lineText(0)).toBe('h0');
    expect(store.lineText(1)).toBe('h1');
    expect(store.lineText(2)).toBe('h2');
    expect(store.lineText(3)).toBe('v0');
    expect(store.lineText(4)).toBe('v1');
    expect(store.lineText(5)).toBe('v2');
  });

  it('rejects a dump whose viewport line is absolute (>= rows), locking the convention', () => {
    const rows = 2;
    const historyRows = [textRow(0, 'h0'), textRow(1, 'h1')];
    // Wrong convention: viewport lines offset by history_len (2, 3) instead of (0, 1).
    const badViewport = [
      { ...textRow(0, 'v0'), line: historyRows.length },
      { ...textRow(1, 'v1'), line: historyRows.length + 1 },
    ];
    const bad: GridSnapshotDump = {
      ...fixture(),
      rows,
      totalLines: historyRows.length + rows,
      historyRows,
      viewport: badViewport,
    };
    expect(() => validateArchivedSnapshot(bad)).toThrow('archived snapshot unavailable');
  });

  it('retains all history rows (capacity >= historyRows.length; 5000 coexist)', () => {
    const history = Array.from({ length: 5000 }, (_, i) => textRow(i, `h${i}`));
    const dump: GridSnapshotDump = {
      ...fixture(),
      totalLines: 5002,
      historyRows: history,
      viewport: [textRow(0, 'a'), textRow(1, 'b')],
    };
    const store = gridStoreFromArchivedSnapshot(dump);
    expect(store.cachedHistoryCount).toBe(5000);
  });
});

describe('validateArchivedSnapshot', () => {
  it('rejects a totalLines mismatch', () => {
    expect(() => validateArchivedSnapshot({ ...fixture(), totalLines: 4 })).toThrow(
      'archived snapshot unavailable',
    );
  });

  it('rejects invalid dimensions', () => {
    expect(() => validateArchivedSnapshot({ ...fixture(), rows: 0 })).toThrow(
      'archived snapshot unavailable',
    );
  });

  it('rejects an out-of-range viewport row index', () => {
    const bad = fixture();
    bad.viewport = [textRow(0, 'head'), { ...textRow(1, 'tail'), line: 9 }];
    expect(() => validateArchivedSnapshot(bad)).toThrow('archived snapshot unavailable');
  });

  it('rejects an out-of-range history row index', () => {
    const bad = fixture();
    bad.historyRows = [{ ...textRow(0, 'oldest'), line: 99 }, textRow(1, 'mid', true), textRow(2, 'z')];
    expect(() => validateArchivedSnapshot(bad)).toThrow('archived snapshot unavailable');
  });
});

describe('isCurrentArchivedRead', () => {
  it('is true only when ids match and the component is live', () => {
    expect(isCurrentArchivedRead('a', 'a', false)).toBe(true);
    expect(isCurrentArchivedRead('a', 'b', false)).toBe(false); // tab switched
    expect(isCurrentArchivedRead('a', 'a', true)).toBe(false); // disposed
    expect(isCurrentArchivedRead(undefined, undefined, false)).toBe(false); // no id
  });
});
