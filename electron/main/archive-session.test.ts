import { describe, it, expect } from "vitest";
import { createArchiveSessionOperations, assertRespawnable, type ArchiveSessionDeps } from "./archive-session";
import type { ArchivedSnapshotBlob, GridSnapshotDump, Tab } from "../../src/types/shared";

const DUMP: GridSnapshotDump = {
  cols: 80,
  rows: 24,
  cursorRow: 0,
  cursorCol: 0,
  totalLines: 0,
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
  historyRows: [],
  viewport: [],
};

function baseTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    directoryId: "d1",
    label: "1",
    cwd: "/tmp",
    sortOrder: 0,
    createdAt: 0,
    ...overrides,
  };
}

interface Harness {
  ops: ReturnType<typeof createArchiveSessionOperations>;
  calls: string[];
  tabs: Map<string, Tab>;
  blobs: Map<string, ArchivedSnapshotBlob>;
}

function makeHarness(opts: {
  snapshotFails?: boolean;
  writeFails?: boolean;
  killRejects?: boolean;
  killFalse?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const tabs = new Map<string, Tab>();
  tabs.set("t1", baseTab());
  const blobs = new Map<string, ArchivedSnapshotBlob>();

  const deps: ArchiveSessionDeps = {
    getTab: (id) => tabs.get(id) ?? null,
    daemonRequest: async <T>(method: string, _params: unknown): Promise<T> => {
      if (method === "tab_snapshot") {
        calls.push("daemon:tab_snapshot");
        if (opts.snapshotFails) throw new Error("snapshot failed");
        return DUMP as unknown as T;
      }
      if (method === "tab_kill") {
        calls.push("daemon:tab_kill");
        if (opts.killRejects) throw new Error("kill rejected");
        return (opts.killFalse ? false : true) as unknown as T;
      }
      throw new Error(`unexpected daemon method: ${method}`);
    },
    writeSnapshot: async (id, dump, capturedAt) => {
      calls.push("db:write_snapshot");
      if (opts.writeFails) throw new Error("write failed");
      blobs.set(id, {
        cols: dump.cols,
        rows: dump.rows,
        cursorRow: dump.cursorRow,
        cursorCol: dump.cursorCol,
        capturedAt,
        payload: new Uint8Array([1, 2, 3]),
      });
    },
    readSnapshot: (id) => blobs.get(id) ?? null,
    setArchivedAt: (id, archivedAt) => {
      calls.push("db:set_archived_at");
      const tab = tabs.get(id);
      if (tab) tabs.set(id, { ...tab, archivedAt });
    },
    now: () => 12345,
  };

  return { ops: createArchiveSessionOperations(deps), calls, tabs, blobs };
}

describe("createArchiveSessionOperations", () => {
  it("archives in strict order: snapshot -> write -> kill -> set_archived_at", async () => {
    const { ops, calls, tabs } = makeHarness();
    const updated = await ops.archive("t1");
    expect(calls).toEqual([
      "daemon:tab_snapshot",
      "db:write_snapshot",
      "daemon:tab_kill",
      "db:set_archived_at",
    ]);
    expect(updated.archivedAt).toBe(12345);
    expect(tabs.get("t1")!.archivedAt).toBe(12345);
  });

  it("throws tab not found for an unknown id and performs no side effects", async () => {
    const { ops, calls } = makeHarness();
    await expect(ops.archive("nope")).rejects.toThrow("tab not found");
    expect(calls).toEqual([]);
  });

  it("is idempotent: already-archived tab returns as-is with no side effects", async () => {
    const { ops, calls, tabs } = makeHarness();
    tabs.set("t1", baseTab({ archivedAt: 999 }));
    const result = await ops.archive("t1");
    expect(result.archivedAt).toBe(999);
    expect(calls).toEqual([]);
  });

  it("snapshot failure performs no write, no kill, no update", async () => {
    const { ops, calls, blobs } = makeHarness({ snapshotFails: true });
    await expect(ops.archive("t1")).rejects.toThrow("snapshot failed");
    expect(calls).toEqual(["daemon:tab_snapshot"]);
    expect(blobs.size).toBe(0);
  });

  it("write failure performs no kill, no update", async () => {
    const { ops, calls, blobs } = makeHarness({ writeFails: true });
    await expect(ops.archive("t1")).rejects.toThrow("write failed");
    expect(calls).toEqual(["daemon:tab_snapshot", "db:write_snapshot"]);
    expect(blobs.size).toBe(0);
  });

  it("kill returning false leaves archived_at null, keeps the blob, rejects", async () => {
    const { ops, calls, tabs, blobs } = makeHarness({ killFalse: true });
    await expect(ops.archive("t1")).rejects.toThrow(
      "failed to stop session; snapshot retained for retry",
    );
    expect(calls).toEqual(["daemon:tab_snapshot", "db:write_snapshot", "daemon:tab_kill"]);
    expect(tabs.get("t1")!.archivedAt).toBeUndefined();
    expect(blobs.has("t1")).toBe(true);
  });

  it("kill rejection leaves archived_at null, keeps the blob, rejects", async () => {
    const { ops, calls, tabs, blobs } = makeHarness({ killRejects: true });
    await expect(ops.archive("t1")).rejects.toThrow(
      "failed to stop session; snapshot retained for retry",
    );
    expect(calls).toEqual(["daemon:tab_snapshot", "db:write_snapshot", "daemon:tab_kill"]);
    expect(tabs.get("t1")!.archivedAt).toBeUndefined();
    expect(blobs.has("t1")).toBe(true);
  });

  it("read returns null when no snapshot row exists", () => {
    const { ops } = makeHarness();
    expect(ops.read("t1")).toBeNull();
  });

  it("read returns the stored bytes unchanged (no decode)", async () => {
    const { ops } = makeHarness();
    await ops.archive("t1");
    const blob = ops.read("t1");
    expect(blob).not.toBeNull();
    expect(blob!.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(blob!.capturedAt).toBe(12345);
  });
});

describe("assertRespawnable", () => {
  // Guards the legacy tabs_session_id live-session seam: an archived row must
  // never respawn through it (that would create a second source of truth for
  // an archived tab). Only tabs_unarchive may bring it back.
  it("throws for an archived tab", () => {
    expect(() => assertRespawnable(baseTab({ archivedAt: 12345 }))).toThrow(
      "archived session cannot spawn",
    );
  });

  it("allows a live (non-archived) tab", () => {
    expect(() => assertRespawnable(baseTab())).not.toThrow();
  });
});
