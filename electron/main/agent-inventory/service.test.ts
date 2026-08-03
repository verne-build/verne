import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentInventoryItem,
  AgentInventoryKey,
  AgentInventoryProbeItem,
  AgentInventorySnapshot,
  PersistedAgentInventorySnapshot,
} from "../../../src/types/agentInventory";
import type { LatestVersionResult } from "./latest";
import { AgentInventoryService, INVENTORY_TTL_MS, type AgentInventoryServiceDeps } from "./service";
import { AGENT_INVENTORY_KEYS } from "./store";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const DISPLAY_NAMES: Record<AgentInventoryKey, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
};

function probeItem(key: AgentInventoryKey, available = false): AgentInventoryProbeItem {
  return {
    key,
    displayName: DISPLAY_NAMES[key],
    discoveryStatus: available ? "available" : "missing",
    resolvedBinary: available ? `/opt/tools/${key}` : null,
    resolvedAlias: available ? key : null,
    versionProbe: { kind: "semver", args: ["--version"], fallback_args: null },
    latestSource: { kind: "grok-cli" },
    update: { kind: "command", command: `${key} update` },
  };
}

function probeRowsWithOnly(...available: AgentInventoryKey[]): AgentInventoryProbeItem[] {
  return AGENT_INVENTORY_KEYS.map((key) => probeItem(key, available.includes(key)));
}

function missingItem(key: AgentInventoryKey): AgentInventoryItem {
  return {
    key,
    displayName: DISPLAY_NAMES[key],
    discoveryStatus: "missing",
    resolvedBinary: null,
    resolvedAlias: null,
    currentVersion: null,
    latestVersion: null,
    updateStatus: "unknown",
    updateCommand: null,
    updateUrl: null,
    errorCode: null,
    pendingPhase: null,
  };
}

function snapshotAt(checkedAtMs: number, agents = AGENT_INVENTORY_KEYS.map(missingItem)): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents,
    checkedAt: new Date(checkedAtMs).toISOString(),
    expiresAt: new Date(checkedAtMs + INVENTORY_TTL_MS).toISOString(),
    refreshError: null,
    complete: true,
  };
}

/** The on-disk projection: no `complete`, no `pendingPhase`. */
function persisted(snapshot: AgentInventorySnapshot): PersistedAgentInventorySnapshot {
  const { complete: _complete, agents, ...rest } = snapshot;
  return { ...rest, agents: agents.map(({ pendingPhase: _pendingPhase, ...agent }) => agent) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Drains queued microtasks so coalesced progress events have flushed. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function createService(overrides: Partial<AgentInventoryServiceDeps> & { cached?: AgentInventorySnapshot | null } = {}) {
  const cached = overrides.cached ?? null;
  const deps: AgentInventoryServiceDeps = {
    probe: vi.fn().mockResolvedValue(probeRowsWithOnly()),
    probeVersion: vi.fn().mockResolvedValue("1.0.0"),
    resolveLatest: vi.fn().mockResolvedValue({ version: "1.0.0", packageName: null }),
    read: vi.fn(() => cached),
    write: vi.fn(),
    emit: vi.fn(),
    now: vi.fn(() => NOW),
    ...overrides,
  };
  return { service: new AgentInventoryService(deps), deps };
}

describe("agent inventory service", () => {
  it("logs one sanitized total-discovery diagnostic on rejection", async () => {
    const events: unknown[] = [];
    const rawError = "PRIVATE_DISCOVERY_ERROR PATH=/Users/alice/bin ENV=secret";
    const { service } = createService(Object.assign({
      probe: vi.fn().mockRejectedValue(new Error(rawError)),
      now: vi.fn()
        .mockReturnValueOnce(NOW)
        .mockReturnValueOnce(NOW + 17),
    }, {
      diagnostic: (event: unknown) => events.push(event),
    }));

    await service.refresh();

    expect(events).toEqual([{
      key: "inventory",
      code: "discovery-rejected",
      durationMs: 17,
      httpStatus: null,
    }]);
    expect(JSON.stringify(events)).not.toContain(rawError);
    expect(JSON.stringify(events)).not.toContain("/Users/alice/bin");
    expect(JSON.stringify(events)).not.toContain("ENV=secret");
  });

  it("does not diagnose successful discovery containing missing agents", async () => {
    const events: unknown[] = [];
    const { service } = createService(Object.assign({}, {
      diagnostic: (event: unknown) => events.push(event),
    }));

    await service.refresh();

    expect(events).toEqual([]);
  });

  it("deduplicates concurrent refreshes", async () => {
    const pending = deferred<AgentInventoryProbeItem[]>();
    const { service, deps } = createService({ probe: vi.fn(() => pending.promise) });

    const a = service.refresh();
    const b = service.refresh();
    pending.resolve(probeRowsWithOnly());

    await expect(Promise.all([a, b])).resolves.toEqual([snapshotAt(NOW), snapshotAt(NOW)]);
    expect(deps.probe).toHaveBeenCalledTimes(1);
  });

  it("serves stale state while its refresh runs", async () => {
    const stale = snapshotAt(NOW - INVENTORY_TTL_MS);
    const pending = deferred<AgentInventoryProbeItem[]>();
    const { service } = createService({ cached: stale, probe: vi.fn(() => pending.promise) });

    const refresh = service.refreshIfStale();
    expect(service.get()).toEqual(stale);
    pending.resolve(probeRowsWithOnly());
    await expect(refresh).resolves.toEqual(snapshotAt(NOW));
  });

  it("owns cached state independently of read and get callers", async () => {
    const cached = snapshotAt(NOW);
    const expected = snapshotAt(NOW);
    const { service, deps } = createService({ cached });

    cached.checkedAt = new Date(NOW - INVENTORY_TTL_MS).toISOString();
    cached.agents[0].displayName = "mutated read";
    const visible = service.get()!;
    expect(visible).toEqual(expected);

    visible.checkedAt = new Date(NOW - INVENTORY_TTL_MS).toISOString();
    visible.agents[0].displayName = "mutated get";
    await service.refreshIfStale();

    expect(deps.probe).not.toHaveBeenCalled();
    expect(service.get()).toEqual(expected);
  });

  it.each([
    [3_599_999, 0],
    [3_600_000, 1],
  ])("refreshes at the one-hour boundary: age=%i", async (age, calls) => {
    const { service, deps } = createService({ cached: snapshotAt(NOW - age) });

    await service.refreshIfStale();

    expect(deps.probe).toHaveBeenCalledTimes(calls);
  });

  it("starts an agent's latest check only after its own version probe finishes", async () => {
    const versions = deferred<string | null>();
    const resolveLatest = vi.fn<AgentInventoryServiceDeps["resolveLatest"]>()
      .mockResolvedValue({ version: "1.0.0", packageName: null });
    const { service } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      probeVersion: vi.fn(() => versions.promise),
      resolveLatest,
    });

    const refresh = service.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveLatest).not.toHaveBeenCalled();
    versions.resolve("1.0.0");
    await refresh;
    expect(resolveLatest).toHaveBeenCalledTimes(1);
  });

  it("skips latest checks when the current version cannot parse", async () => {
    const { service, deps } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      probeVersion: vi.fn().mockResolvedValue(null),
    });

    const next = await service.refresh();

    expect(deps.resolveLatest).not.toHaveBeenCalled();
    expect(next.agents[0]).toMatchObject({ currentVersion: null, latestVersion: null, updateStatus: "unknown", errorCode: "version" });
  });

  it("keeps the prior rows after total discovery failure", async () => {
    const previous = snapshotAt(NOW - INVENTORY_TTL_MS);
    const { service, deps } = createService({
      cached: previous,
      probe: vi.fn().mockRejectedValue(new Error("discovery details")),
    });

    const next = await service.refresh();

    expect(next.agents).toEqual(previous.agents);
    expect(next.refreshError).toBe("discovery");
    expect(Date.parse(next.expiresAt) - Date.parse(next.checkedAt)).toBe(3_600_000);
    expect(deps.write).toHaveBeenCalledWith(persisted(next));
  });

  it("suppresses timestamp-only row changes across progress events", async () => {
    const previous = snapshotAt(NOW - INVENTORY_TTL_MS);
    const emitted: AgentInventorySnapshot[] = [];
    const { service } = createService({
      cached: previous,
      emit: vi.fn((snapshot) => emitted.push(snapshot)),
    });

    await service.refresh();

    // Rows never changed, so every event differs only by refresh progress.
    expect(emitted.every((snapshot) => isDeepStrictEqual(snapshot.agents, previous.agents))).toBe(true);
    expect(emitted.map((snapshot) => snapshot.complete)).toEqual([false, true]);
  });

  it("creates seven ordered unknown rows when first discovery fails", async () => {
    const { service } = createService({
      cached: null,
      probe: vi.fn().mockRejectedValue(new Error("discovery")),
    });

    const next = await service.refresh();

    expect(next.agents.map((agent) => agent.key)).toEqual(AGENT_INVENTORY_KEYS);
    expect(next.agents).toHaveLength(7);
    expect(next.agents.every((agent) => agent.discoveryStatus === "unknown" && agent.errorCode === "discovery")).toBe(true);
  });

  it("manual refresh bypasses a fresh cache", async () => {
    const { service, deps } = createService({ cached: snapshotAt(NOW) });

    await service.refresh();

    expect(deps.probe).toHaveBeenCalledTimes(1);
  });

  it("version-probes only installed agents", async () => {
    const { service, deps } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
    });

    await service.refresh();

    expect(deps.probeVersion).toHaveBeenCalledTimes(1);
    expect(deps.probeVersion).toHaveBeenCalledWith(expect.objectContaining({ key: "claude" }));
  });

  it("marks a failed latest check unknown for the full cache period", async () => {
    const { service } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      resolveLatest: vi.fn().mockResolvedValue({ version: null, packageName: null } satisfies LatestVersionResult),
    });

    const next = await service.refresh();

    expect(next.agents[0]).toMatchObject({
      discoveryStatus: "installed",
      currentVersion: "1.0.0",
      latestVersion: null,
      updateStatus: "unknown",
      errorCode: "latest",
    });
    expect(Date.parse(next.expiresAt) - Date.parse(next.checkedAt)).toBe(INVENTORY_TTL_MS);
  });

  it("emits when inventory content changes and persists before final publication", async () => {
    const order: string[] = [];
    const { service, deps } = createService({
      cached: snapshotAt(NOW - INVENTORY_TTL_MS),
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      write: vi.fn(() => order.push("write")),
      emit: vi.fn(() => order.push("emit")),
    });

    const next = await service.refresh();

    // Progress events precede persistence; the completed snapshot never does.
    expect(order.slice(-2)).toEqual(["write", "emit"]);
    expect(order.filter((entry) => entry === "write")).toEqual(["write"]);
    expect(deps.emit).toHaveBeenLastCalledWith(next);
    expect(deps.write).toHaveBeenCalledWith(persisted(next));
    expect(service.get()).toEqual(next);
  });

  it("isolates write and emit recipients from retained and returned refresh state", async () => {
    let emittedCheckedAt = "";
    let emittedDisplayName = "";
    const expected = snapshotAt(NOW);
    const { service } = createService({
      write: vi.fn((snapshot) => {
        snapshot.checkedAt = new Date(NOW - INVENTORY_TTL_MS).toISOString();
        snapshot.agents[0].displayName = "mutated write";
      }),
      emit: vi.fn((snapshot) => {
        emittedCheckedAt = snapshot.checkedAt;
        emittedDisplayName = snapshot.agents[0].displayName;
        snapshot.expiresAt = new Date(NOW + 2 * INVENTORY_TTL_MS).toISOString();
        snapshot.agents[0].displayName = "mutated emit";
      }),
    });

    const refreshed = await service.refresh();

    expect(emittedCheckedAt).toBe(expected.checkedAt);
    expect(emittedDisplayName).toBe(expected.agents[0].displayName);
    expect(refreshed).toEqual(expected);
    refreshed.agents[0].displayName = "mutated refresh";
    expect(service.get()).toEqual(expected);
  });

  it("returns independent snapshots to concurrent refresh callers", async () => {
    const { service } = createService();

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);
    first.agents[0].displayName = "mutated first caller";

    expect(second).toEqual(snapshotAt(NOW));
    expect(service.get()).toEqual(snapshotAt(NOW));
  });

  it("publishes discovered rows before any version resolves", async () => {
    const versions = deferred<string | null>();
    const emitted: AgentInventorySnapshot[] = [];
    const { service } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      probeVersion: vi.fn(() => versions.promise),
      emit: vi.fn((snapshot) => emitted.push(snapshot)),
    });

    const refresh = service.refresh();
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.complete).toBe(false);
    expect(emitted[0]!.agents).toHaveLength(7);
    expect(emitted[0]!.agents[0]).toMatchObject({
      key: "claude",
      discoveryStatus: "installed",
      resolvedBinary: "/opt/tools/claude",
      currentVersion: null,
      pendingPhase: "version",
    });
    expect(emitted[0]!.agents[1]).toMatchObject({ key: "codex", discoveryStatus: "missing", pendingPhase: null });

    versions.resolve("1.0.0");
    await refresh;
  });

  it("advances one row's phases without waiting on a stalled sibling", async () => {
    const stalled = deferred<string | null>();
    const emitted: AgentInventorySnapshot[] = [];
    const { service } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude", "codex")),
      probeVersion: vi.fn((item: AgentInventoryProbeItem) =>
        item.key === "claude" ? stalled.promise : Promise.resolve("2.0.0"),
      ),
      emit: vi.fn((snapshot) => emitted.push(snapshot)),
    });

    const refresh = service.refresh();
    await flushMicrotasks();

    const latest = emitted.at(-1)!;
    expect(latest.complete).toBe(false);
    expect(latest.agents[0]).toMatchObject({ key: "claude", currentVersion: null, pendingPhase: "version" });
    expect(latest.agents[1]).toMatchObject({ key: "codex", currentVersion: "2.0.0", pendingPhase: null });

    stalled.resolve("1.0.0");
    const next = await refresh;
    expect(next.complete).toBe(true);
    expect(next.agents.every((agent) => agent.pendingPhase === null)).toBe(true);
  });

  it("coalesces rows that settle together into one event", async () => {
    const emitted: AgentInventorySnapshot[] = [];
    const { service } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude", "codex", "opencode")),
      emit: vi.fn((snapshot) => emitted.push(snapshot)),
    });

    await service.refresh();

    // Three rows × two phases plus discovery would be seven un-coalesced events.
    expect(emitted.length).toBeLessThan(7);
    expect(emitted.at(-1)!.complete).toBe(true);
  });

  it("clears the pending phase of a row whose version probe rejects", async () => {
    const { service } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude", "codex")),
      probeVersion: vi.fn((item: AgentInventoryProbeItem) =>
        item.key === "claude" ? Promise.reject(new Error("exit 127")) : Promise.resolve("2.0.0"),
      ),
    });

    const next = await service.refresh();

    expect(next.agents[0]).toMatchObject({ key: "claude", errorCode: "version", pendingPhase: null });
    expect(next.agents[1]).toMatchObject({ key: "codex", currentVersion: "2.0.0", errorCode: null });
  });

  it("keeps showing a cached version while it re-resolves, and drops a stale latest", async () => {
    const cachedRow: AgentInventoryItem = {
      ...missingItem("claude"),
      discoveryStatus: "installed",
      resolvedBinary: "/opt/tools/claude",
      resolvedAlias: "claude",
      currentVersion: "0.9.0",
      latestVersion: "0.9.9",
      updateStatus: "outdated",
    };
    const versions = deferred<string | null>();
    const latest = deferred<LatestVersionResult>();
    const emitted: AgentInventorySnapshot[] = [];
    const { service } = createService({
      cached: snapshotAt(NOW - INVENTORY_TTL_MS, [
        cachedRow,
        ...AGENT_INVENTORY_KEYS.slice(1).map(missingItem),
      ]),
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      probeVersion: vi.fn(() => versions.promise),
      resolveLatest: vi.fn(() => latest.promise),
      emit: vi.fn((snapshot) => emitted.push(snapshot)),
    });

    const refresh = service.refresh();
    await flushMicrotasks();

    expect(emitted.at(-1)!.agents[0]).toMatchObject({
      currentVersion: "0.9.0",
      latestVersion: "0.9.9",
      pendingPhase: "version",
    });

    versions.resolve("1.0.0");
    await flushMicrotasks();

    // The version moved, so the cached latest no longer describes this install.
    expect(emitted.at(-1)!.agents[0]).toMatchObject({
      currentVersion: "1.0.0",
      latestVersion: null,
      updateStatus: "unknown",
      pendingPhase: "latest",
    });

    latest.resolve({ version: "1.1.0", packageName: null });
    const next = await refresh;
    expect(next.agents[0]).toMatchObject({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateStatus: "outdated" });
  });

  it("never persists transient progress fields", async () => {
    const { service, deps } = createService({
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
    });

    await service.refresh();

    const written = vi.mocked(deps.write).mock.calls[0]![0] as Record<string, unknown>;
    expect(written).not.toHaveProperty("complete");
    expect(Object.keys(written.agents as object[])).toHaveLength(7);
    for (const agent of written.agents as Record<string, unknown>[]) {
      expect(agent).not.toHaveProperty("pendingPhase");
    }
  });

  it("serves the in-flight partial rather than a stale cache once rows land", async () => {
    const stale = snapshotAt(NOW - INVENTORY_TTL_MS);
    const versions = deferred<string | null>();
    const { service } = createService({
      cached: stale,
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      probeVersion: vi.fn(() => versions.promise),
    });

    const refresh = service.refresh();
    await flushMicrotasks();

    expect(service.get()).toMatchObject({ complete: false });
    expect(service.get()!.agents[0]).toMatchObject({ discoveryStatus: "installed", pendingPhase: "version" });

    versions.resolve("1.0.0");
    await refresh;
  });

  it("keeps failure replacements isolated from cached and persisted rows", async () => {
    const cached = snapshotAt(NOW - INVENTORY_TTL_MS);
    const expected: AgentInventorySnapshot = {
      ...snapshotAt(NOW),
      refreshError: "discovery",
    };
    const { service } = createService({
      cached,
      probe: vi.fn().mockRejectedValue(new Error("discovery")),
      write: vi.fn((snapshot) => {
        snapshot.agents[0].displayName = "mutated persisted failure";
      }),
    });
    cached.agents[0].displayName = "mutated cached rows";

    const refreshed = await service.refresh();

    expect(refreshed).toEqual(expected);
    refreshed.agents[0].displayName = "mutated returned failure";
    expect(service.get()).toEqual(expected);
  });
});
