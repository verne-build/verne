import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { openDb } from "./connection";
import { insertDirectory } from "./directories";
import { insertTab, deleteTab } from "./tabs";
import { writeTabSnapshot, readTabSnapshotBlob, deleteTabSnapshot } from "./tabSnapshots";
import type { GridSnapshotDump } from "../../../src/types/shared";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-tab-snapshots-"));
  const db = openDb(join(dir, "verne.db"));
  insertDirectory(db, { id: "d1", path: "/tmp/d1", name: "dir-one", createdAt: 0, sortOrder: 0 });
  insertTab(db, {
    id: "t1",
    directoryId: "d1",
    label: "1",
    cwd: "/tmp/d1",
    sortOrder: 0,
    createdAt: 100,
    userRenamed: false,
  });
  return db;
}

function mkDump(overrides: Partial<GridSnapshotDump> = {}): GridSnapshotDump {
  return {
    cols: 80,
    rows: 24,
    cursorRow: 3,
    cursorCol: 7,
    totalLines: 2,
    base: 0,
    cursorShape: "block",
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
      {
        line: 0,
        startCol: 0,
        wrapped: true,
        cells: [
          { cp: 0x41, fg: 0xff0000ff, bg: 0x000000ff, flags: 1, width: 1 },
        ],
      },
    ],
    viewport: [
      {
        line: 1,
        startCol: 0,
        wrapped: false,
        cells: [
          { cp: 0x42, fg: 0x00ff00ff, bg: 0x000000ff, flags: 0, width: 1, ulColor: 0x0000ffff, link: "https://example.com" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("tabSnapshots", () => {
  it("writes a gzip blob that gunzips back to the exact JSON dump", async () => {
    const db = tmpDb();
    const dump = mkDump();
    await writeTabSnapshot(db, "t1", dump, 999);
    const blob = readTabSnapshotBlob(db, "t1");
    expect(blob).toBeTruthy();
    expect(blob!.cols).toBe(80);
    expect(blob!.rows).toBe(24);
    expect(blob!.cursorRow).toBe(3);
    expect(blob!.cursorCol).toBe(7);
    expect(blob!.capturedAt).toBe(999);
    const decoded = JSON.parse(gunzipSync(Buffer.from(blob!.payload)).toString("utf8"));
    expect(decoded).toEqual(dump);
  });

  it("upserts on repeated writes for the same tab", async () => {
    const db = tmpDb();
    await writeTabSnapshot(db, "t1", mkDump(), 1);
    await writeTabSnapshot(db, "t1", mkDump({ cursorRow: 9 }), 2);
    const blob = readTabSnapshotBlob(db, "t1");
    expect(blob!.cursorRow).toBe(9);
    expect(blob!.capturedAt).toBe(2);
    const count = db.prepare("SELECT COUNT(*) AS n FROM tab_snapshots WHERE tab_id = ?").get("t1") as { n: number };
    expect(count.n).toBe(1);
  });

  it("readTabSnapshotBlob returns null when absent", () => {
    const db = tmpDb();
    expect(readTabSnapshotBlob(db, "t1")).toBeNull();
    expect(readTabSnapshotBlob(db, "nope")).toBeNull();
  });

  it("deleteTabSnapshot removes the row", async () => {
    const db = tmpDb();
    await writeTabSnapshot(db, "t1", mkDump(), 1);
    deleteTabSnapshot(db, "t1");
    expect(readTabSnapshotBlob(db, "t1")).toBeNull();
  });

  it("cascades snapshot deletion when the parent tab is deleted", async () => {
    const db = tmpDb();
    await writeTabSnapshot(db, "t1", mkDump(), 1);
    deleteTab(db, "t1");
    expect(readTabSnapshotBlob(db, "t1")).toBeNull();
  });

  it("round-trips a 5000-row dump and records compressed/uncompressed byte counts", async () => {
    const db = tmpDb();
    const historyRows = Array.from({ length: 5000 }, (_, i) => ({
      line: i,
      startCol: 0,
      wrapped: i % 7 === 0,
      cells: Array.from({ length: 80 }, (_, c) => ({
        cp: 0x20 + ((i + c) % 90),
        fg: 0xffffffff,
        bg: 0x000000ff,
        flags: (i + c) % 2,
        width: 1,
      })),
    }));
    const dump = mkDump({ totalLines: 5000, historyRows });
    const uncompressedSize = Buffer.byteLength(JSON.stringify(dump), "utf8");
    await writeTabSnapshot(db, "t1", dump, 42);
    const blob = readTabSnapshotBlob(db, "t1");
    const decoded = JSON.parse(gunzipSync(Buffer.from(blob!.payload)).toString("utf8"));
    expect(decoded).toEqual(dump);
    expect(
      blob!.payload.byteLength,
      `5000-row snapshot: ${uncompressedSize} bytes uncompressed -> ${blob!.payload.byteLength} bytes gzipped`
    ).toBeGreaterThan(0);
  });
});
