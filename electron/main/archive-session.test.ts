import { describe, it, expect } from "vitest";
import {
  archiveDisplayTitle,
  createArchiveSessionOperations,
  assertRespawnable,
  type ArchiveSessionDeps,
} from "./archive-session";
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
  plans: Array<{ tab: Tab; launchOverride?: string }>;
}

function makeHarness(opts: {
  snapshotFails?: boolean;
  writeFails?: boolean;
  killRejects?: boolean;
  killFalse?: boolean;
  spawnFails?: boolean;
  commitFails?: boolean;
  initialTab?: Tab;
  seedBlob?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const tabs = new Map<string, Tab>();
  tabs.set("t1", opts.initialTab ?? baseTab());
  const blobs = new Map<string, ArchivedSnapshotBlob>();
  const plans: Array<{ tab: Tab; launchOverride?: string }> = [];
  if (opts.seedBlob) {
    blobs.set("t1", {
      cols: 80, rows: 24, cursorRow: 0, cursorCol: 0, capturedAt: 12345,
      payload: new Uint8Array([1, 2, 3]),
    });
  }
  // Snapshot for BEGIN/ROLLBACK simulation so a failed transaction restores
  // the pre-transaction tabs+blobs state, mirroring node:sqlite semantics.
  let tx: { tabs: Map<string, Tab>; blobs: Map<string, ArchivedSnapshotBlob> } | null = null;

  const deps: ArchiveSessionDeps = {
    getTab: (id) => tabs.get(id) ?? null,
    daemonRequest: async <T>(method: string, _params: unknown): Promise<T> => {
      if (method === "tab_snapshot") {
        calls.push("daemon:tab_snapshot");
        if (opts.snapshotFails) throw new Error("snapshot failed");
        return DUMP as unknown as T;
      }
      if (method === "tab_spawn") {
        calls.push("daemon:tab_spawn");
        if (opts.spawnFails) throw new Error("spawn failed");
        return undefined as unknown as T;
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
      if (tab) tabs.set(id, { ...tab, archivedAt: archivedAt ?? undefined });
    },
    deleteSnapshot: (id) => {
      calls.push("db:delete_snapshot");
      blobs.delete(id);
    },
    dbExec: (sql) => {
      calls.push(`db:${sql}`);
      if (sql === "BEGIN") tx = { tabs: new Map(tabs), blobs: new Map(blobs) };
      if (sql === "COMMIT" && opts.commitFails) throw new Error("commit failed");
      if (sql === "ROLLBACK" && tx) {
        tabs.clear(); for (const [k, v] of tx.tabs) tabs.set(k, v);
        blobs.clear(); for (const [k, v] of tx.blobs) blobs.set(k, v);
      }
    },
    buildPlan: (tab, launchOverride) => {
      plans.push({ tab, launchOverride });
      return { tabId: tab.id, launchOverride };
    },
    now: () => 12345,
  };

  return { ops: createArchiveSessionOperations(deps), calls, tabs, blobs, plans };
}

describe("archiveDisplayTitle", () => {
  it("prefers the daemon OSC title over a generic renderer fallback", () => {
    expect(archiveDisplayTitle(baseTab(), { title: "Fix archived titles" }, "Claude"))
      .toBe("Fix archived titles");
  });

  it("keeps explicit and generated titles ahead of transient daemon state", () => {
    expect(archiveDisplayTitle(
      baseTab({ userRenamed: true, label: "My Session" }),
      { displayTitle: "Daemon title" },
      "Renderer title",
    )).toBe("My Session");
    expect(archiveDisplayTitle(
      baseTab({ generatedTitle: "Generated title" }),
      { displayTitle: "Daemon title" },
      "Renderer title",
    )).toBe("Generated title");
  });
});

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

describe("unarchive", () => {
  function archivedTab(overrides: Partial<Tab> = {}): Tab {
    return baseTab({ archivedAt: 12345, ...overrides });
  }

  it("resume + claude + session id passes the resume launchOverride", async () => {
    const { ops, plans } = makeHarness({
      initialTab: archivedTab({ lastAgentType: "claude", lastAgentSessionId: "abc-123" }),
      seedBlob: true,
    });
    await ops.unarchive("t1", true);
    expect(plans).toHaveLength(1);
    expect(plans[0].launchOverride).toBe("claude --resume 'abc-123'");
  });

  it("fresh shell passes undefined launchOverride", async () => {
    const { ops, plans } = makeHarness({
      initialTab: archivedTab({ lastAgentType: "claude", lastAgentSessionId: "abc-123" }),
      seedBlob: true,
    });
    await ops.unarchive("t1", false);
    expect(plans[0].launchOverride).toBeUndefined();
  });

  it("resume with an unknown agent falls back to a fresh shell (undefined)", async () => {
    const { ops, plans } = makeHarness({
      initialTab: archivedTab({ lastAgentType: "definitely-not-an-agent", lastAgentSessionId: "abc-123" }),
      seedBlob: true,
    });
    await ops.unarchive("t1", true);
    expect(plans[0].launchOverride).toBeUndefined();
  });

  it("resume with a missing session id falls back to a fresh shell (undefined)", async () => {
    const { ops, plans } = makeHarness({
      initialTab: archivedTab({ lastAgentType: "claude" }),
      seedBlob: true,
    });
    await ops.unarchive("t1", true);
    expect(plans[0].launchOverride).toBeUndefined();
  });

  it("spawns before deleting archive metadata, clears archived_at, deletes blob", async () => {
    const { ops, calls, tabs, blobs } = makeHarness({
      initialTab: archivedTab(),
      seedBlob: true,
    });
    const updated = await ops.unarchive("t1", false);
    expect(calls).toEqual([
      "daemon:tab_spawn",
      "db:BEGIN",
      "db:set_archived_at",
      "db:delete_snapshot",
      "db:COMMIT",
    ]);
    expect(updated.archivedAt).toBeUndefined();
    expect(tabs.get("t1")!.archivedAt).toBeUndefined();
    expect(blobs.has("t1")).toBe(false);
  });

  it("rejects a non-archived tab with no side effects", async () => {
    const { ops, calls } = makeHarness({ initialTab: baseTab() });
    await expect(ops.unarchive("t1", false)).rejects.toThrow("session is not archived");
    expect(calls).toEqual([]);
  });

  it("rejects an unknown tab with no side effects", async () => {
    const { ops, calls } = makeHarness({ initialTab: archivedTab() });
    await expect(ops.unarchive("nope", false)).rejects.toThrow("tab not found");
    expect(calls).toEqual([]);
  });

  it("spawn failure leaves archived_at and snapshot untouched", async () => {
    const { ops, calls, tabs, blobs } = makeHarness({
      initialTab: archivedTab(),
      seedBlob: true,
      spawnFails: true,
    });
    await expect(ops.unarchive("t1", false)).rejects.toThrow("spawn failed");
    expect(calls).toEqual(["daemon:tab_spawn"]);
    expect(tabs.get("t1")!.archivedAt).toBe(12345);
    expect(blobs.has("t1")).toBe(true);
  });

  it("db-finalize failure kills the spawned session, keeps the archive intact, rethrows", async () => {
    const { ops, calls, tabs, blobs } = makeHarness({
      initialTab: archivedTab(),
      seedBlob: true,
      commitFails: true,
    });
    await expect(ops.unarchive("t1", false)).rejects.toThrow("commit failed");
    expect(calls).toEqual([
      "daemon:tab_spawn",
      "db:BEGIN",
      "db:set_archived_at",
      "db:delete_snapshot",
      "db:COMMIT",
      "db:ROLLBACK",
      "daemon:tab_kill",
    ]);
    expect(tabs.get("t1")!.archivedAt).toBe(12345);
    expect(blobs.has("t1")).toBe(true);
  });

  it("db-finalize + rollback-kill rejection raises the AggregateError", async () => {
    const { ops } = makeHarness({
      initialTab: archivedTab(),
      seedBlob: true,
      commitFails: true,
      killRejects: true,
    });
    await expect(ops.unarchive("t1", false)).rejects.toThrow("failed to restore archived-only state");
  });

  it("db-finalize + rollback-kill returning false raises the AggregateError", async () => {
    const { ops } = makeHarness({
      initialTab: archivedTab(),
      seedBlob: true,
      commitFails: true,
      killFalse: true,
    });
    const err = await ops.unarchive("t1", false).catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as Error).message).toBe("failed to restore archived-only state");
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
