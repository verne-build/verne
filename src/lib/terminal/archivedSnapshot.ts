// Renderer-side replay of an archived terminal snapshot: decompress the stored
// gzip blob, validate it, and seed a GridStore through its existing sync/history
// frame path so a read-only TerminalController can paint + scroll it. The
// daemon's packed fg/bg u32 values already match the renderer's color format
// (see gridProtocol DEFAULT_COLOR/indexedColor/rgbColor), so cells feed straight
// in as RowRuns — no color decode/re-pack here.

import { GridStore } from './GridStore';
import type { ArchivedSnapshotBlob, GridSnapshotDump } from '../../types/shared';

const UNAVAILABLE = 'archived snapshot unavailable';

/** Positive integer (dimensions must be real, finite, > 0). */
function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

/** Non-negative integer. */
function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Throw `archived snapshot unavailable` unless the dump is internally
 *  consistent: positive dims, totalLines == history + rows, and every row's
 *  visual line index in range. When `blob` is given, its captured header dims
 *  must also match the dump (guards a metadata/payload mismatch). */
export function validateArchivedSnapshot(
  dump: GridSnapshotDump,
  blob?: ArchivedSnapshotBlob,
): void {
  if (!dump || typeof dump !== 'object') throw new Error(UNAVAILABLE);
  if (!isPositiveInt(dump.cols) || !isPositiveInt(dump.rows)) throw new Error(UNAVAILABLE);
  if (!isNonNegInt(dump.base)) throw new Error(UNAVAILABLE);
  if (!Array.isArray(dump.historyRows) || !Array.isArray(dump.viewport)) {
    throw new Error(UNAVAILABLE);
  }
  if (!isNonNegInt(dump.totalLines)) throw new Error(UNAVAILABLE);
  if (dump.totalLines !== dump.historyRows.length + dump.rows) throw new Error(UNAVAILABLE);
  // Viewport rows are screen-relative: line ∈ [0, rows).
  for (const run of dump.viewport) {
    if (!isNonNegInt(run.line) || run.line >= dump.rows) throw new Error(UNAVAILABLE);
  }
  // History rows are keyed base + line where line ∈ [0, historyRows.length).
  for (const run of dump.historyRows) {
    if (!isNonNegInt(run.line) || run.line >= dump.historyRows.length) throw new Error(UNAVAILABLE);
  }
  if (blob) {
    if (blob.cols !== dump.cols || blob.rows !== dump.rows) throw new Error(UNAVAILABLE);
  }
}

/** Seed a GridStore from a validated dump via its existing sync + history frame
 *  APIs. Cursor is forced hidden (no blink) — a frozen snapshot has no live
 *  cursor. History capacity is at least `historyRows.length` so all retained
 *  rows coexist (nothing evicts under the LRU cap). */
export function gridStoreFromArchivedSnapshot(dump: GridSnapshotDump): GridStore {
  validateArchivedSnapshot(dump);
  const store = new GridStore(Math.max(2000, dump.historyRows.length));
  store.applyFrame({
    type: 'sync',
    rev: 0,
    cols: dump.cols,
    rows: dump.rows,
    cursor: [dump.cursorRow, dump.cursorCol],
    cursorShape: 'hidden',
    cursorBlink: false,
    altScreen: dump.modes.altScreen,
    modes: dump.modes,
    totalLines: dump.totalLines,
    base: dump.base,
    runs: dump.viewport,
  });
  store.applyFrame({
    type: 'history',
    reqId: 0,
    from: 0,
    to: dump.historyRows.length,
    base: dump.base,
    runs: dump.historyRows,
  });
  return store;
}

/** Decompress + parse + validate a stored snapshot blob. Uses Chromium's
 *  built-in DecompressionStream("gzip") (no dependency). Any failure —
 *  malformed gzip, invalid JSON, dimension mismatch — surfaces as the single
 *  `archived snapshot unavailable` error the host shows. */
export async function decodeArchivedSnapshot(
  blob: ArchivedSnapshotBlob,
): Promise<GridSnapshotDump> {
  try {
    const stream = new Blob([blob.payload as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const dump = JSON.parse(await new Response(stream).text()) as GridSnapshotDump;
    validateArchivedSnapshot(dump, blob);
    return dump;
  } catch {
    throw new Error(UNAVAILABLE);
  }
}

/** True when the snapshot only holds the final screen, not the session's real
 *  history. A full-screen TUI (claude, opencode, vim) runs on the ALT SCREEN,
 *  whose grid has no scrollback — and its own scroll history never reaches the
 *  terminal at all, it repaints one viewport-sized frame and scrolls internally.
 *  So an alt-screen capture is inherently partial and no amount of grid capture
 *  can recover the rest; the host labels it and points at Resume. */
export function isPartialArchivedSnapshot(dump: GridSnapshotDump): boolean {
  return dump.modes?.altScreen === true;
}

/** Stale-tab guard for the async archived read: the still-mounted tab must match
 *  the tab the read was started for, and the component must not have been
 *  disposed. Called after BOTH the IPC read and the decode await so a fast tab
 *  switch never seeds a store for the wrong (or unmounted) pane. */
export function isCurrentArchivedRead(
  requestedTabId: string | undefined,
  currentTabId: string | undefined,
  disposed: boolean,
): boolean {
  return !disposed && requestedTabId != null && requestedTabId === currentTabId;
}
