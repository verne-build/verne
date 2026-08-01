import { describe, expect, it, vi } from "vitest";
import type {
  AgentInventoryItem,
  AgentInventoryKey,
  AgentInventoryProbeItem,
  AgentInventorySnapshot,
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
  };
}

function snapshotAt(checkedAtMs: number, agents = AGENT_INVENTORY_KEYS.map(missingItem)): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents,
    checkedAt: new Date(checkedAtMs).toISOString(),
    expiresAt: new Date(checkedAtMs + INVENTORY_TTL_MS).toISOString(),
    refreshError: null,
  };
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

  it("starts latest checks only after installed-version probes finish", async () => {
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
    expect(deps.write).toHaveBeenCalledWith(next);
  });

  it("suppresses timestamp-only events", async () => {
    const previous = snapshotAt(NOW - INVENTORY_TTL_MS);
    const { service, deps } = createService({ cached: previous });

    await service.refresh();

    expect(deps.emit).not.toHaveBeenCalled();
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

  it("emits when inventory content changes and persists before publication", async () => {
    const order: string[] = [];
    const { service, deps } = createService({
      cached: snapshotAt(NOW - INVENTORY_TTL_MS),
      probe: vi.fn().mockResolvedValue(probeRowsWithOnly("claude")),
      write: vi.fn(() => order.push("write")),
      emit: vi.fn(() => order.push("emit")),
    });

    const next = await service.refresh();

    expect(order).toEqual(["write", "emit"]);
    expect(deps.emit).toHaveBeenCalledWith(next);
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
