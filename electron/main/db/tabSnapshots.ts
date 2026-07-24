import { DatabaseSync } from "node:sqlite";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type { ArchivedSnapshotBlob, GridSnapshotDump } from "../../../src/types/shared";

const gzipAsync = promisify(gzip);

interface SnapshotRow {
  cols: number;
  rows: number;
  cursor_row: number;
  cursor_col: number;
  captured_at: number;
  payload: Uint8Array;
}

/** Compress + persist a tab's grid snapshot dump. Gzip runs off the main
 *  thread's synchronous path (promisified) so large dumps don't stall Electron's
 *  event loop. Upserts — one snapshot row per tab. */
export async function writeTabSnapshot(
  db: DatabaseSync,
  tabId: string,
  dump: GridSnapshotDump,
  capturedAt: number,
): Promise<void> {
  const payload = await gzipAsync(Buffer.from(JSON.stringify(dump), "utf8"));
  db.prepare(`INSERT INTO tab_snapshots
    (tab_id, cols, rows, cursor_row, cursor_col, captured_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tab_id) DO UPDATE SET
      cols=excluded.cols, rows=excluded.rows, cursor_row=excluded.cursor_row,
      cursor_col=excluded.cursor_col, captured_at=excluded.captured_at, payload=excluded.payload`)
    .run(tabId, dump.cols, dump.rows, dump.cursorRow, dump.cursorCol, capturedAt, payload);
}

/** Read the raw (still-gzipped) snapshot blob + its metadata for a tab, or
 *  null if none exists. The renderer decodes/validates the payload; main
 *  returns the compressed bytes unchanged over IPC. */
export function readTabSnapshotBlob(db: DatabaseSync, tabId: string): ArchivedSnapshotBlob | null {
  const row = db.prepare(`SELECT cols, rows, cursor_row, cursor_col, captured_at, payload
    FROM tab_snapshots WHERE tab_id = ?`).get(tabId) as SnapshotRow | undefined;
  return row ? {
    cols: row.cols, rows: row.rows, cursorRow: row.cursor_row,
    cursorCol: row.cursor_col, capturedAt: row.captured_at,
    payload: new Uint8Array(row.payload),
  } : null;
}

export function deleteTabSnapshot(db: DatabaseSync, tabId: string): void {
  db.prepare("DELETE FROM tab_snapshots WHERE tab_id = ?").run(tabId);
}
