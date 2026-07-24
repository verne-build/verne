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
