import { isDeepStrictEqual } from "node:util";
import type {
  AgentInventoryItem,
  AgentInventoryKey,
  AgentInventoryProbeItem,
  AgentInventorySnapshot,
  PersistedAgentInventorySnapshot,
} from "../../../src/types/agentInventory";
import type { LatestVersionResult } from "./latest";
import { AGENT_INVENTORY_KEYS } from "./store";
import { compareAgentVersions, updateGuidance } from "./version";
import { INVENTORY_TTL_MS } from "./constants";
import {
  INVENTORY_DIAGNOSTIC_KEY,
  reportDiagnostic,
  type InventoryDiagnosticDeps,
} from "./diagnostics";

export { INVENTORY_TTL_MS };

const DISPLAY_NAMES: Record<AgentInventoryKey, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
};

export interface AgentInventoryServiceDeps extends InventoryDiagnosticDeps {
  probe: () => Promise<AgentInventoryProbeItem[]>;
  probeVersion: (item: AgentInventoryProbeItem) => Promise<string | null>;
  resolveLatest: (item: AgentInventoryProbeItem) => Promise<LatestVersionResult>;
  read: () => PersistedAgentInventorySnapshot | null;
  write: (snapshot: PersistedAgentInventorySnapshot) => void;
  emit: (snapshot: AgentInventorySnapshot) => void;
  now: () => number;
}

/**
 * Refresh resolves in three stages (discovery → per-agent version → per-agent
 * latest) and publishes after each one, so the settings panel paints rows as
 * soon as discovery lands instead of waiting on the slowest network fetch.
 * Intermediate snapshots carry `complete: false` and are emit-only; the disk
 * cache is written once, from the final state.
 */
export class AgentInventoryService {
  private snapshot: AgentInventorySnapshot | null;
  private published: AgentInventorySnapshot | null;
  private pendingPublish: AgentInventorySnapshot | null = null;
  private publishScheduled = false;
  private inFlight: Promise<AgentInventorySnapshot> | null = null;

  constructor(private readonly deps: AgentInventoryServiceDeps) {
    const cached = deps.read();
    this.snapshot = cached ? hydrate(cached) : null;
    this.published = this.snapshot ? copySnapshot(this.snapshot) : null;
  }

  get(): AgentInventorySnapshot | null {
    return this.snapshot ? copySnapshot(this.snapshot) : null;
  }

  refresh(): Promise<AgentInventorySnapshot> {
    if (!this.inFlight) {
      const pending = this.runRefresh();
      this.inFlight = pending;
      pending.then(
        () => { if (this.inFlight === pending) this.inFlight = null; },
        () => { if (this.inFlight === pending) this.inFlight = null; },
      );
    }
    return this.inFlight.then(copySnapshot);
  }

  refreshIfStale(): Promise<AgentInventorySnapshot> {
    if (this.inFlight) return this.refresh();
    if (this.snapshot && this.deps.now() - Date.parse(this.snapshot.checkedAt) < INVENTORY_TTL_MS) {
      return Promise.resolve(copySnapshot(this.snapshot));
    }
    return this.refresh();
  }

  private async runRefresh(): Promise<AgentInventorySnapshot> {
    const checkedAtMs = this.deps.now();
    const previous = this.snapshot;

    let rows: AgentInventoryProbeItem[];
    try {
      rows = await this.deps.probe();
    } catch {
      reportDiagnostic(this.deps, INVENTORY_DIAGNOSTIC_KEY, "discovery-rejected", checkedAtMs);
      return this.commit(
        previous?.agents.map(copyAgent) ?? AGENT_INVENTORY_KEYS.map(unknownAgent),
        checkedAtMs,
        "discovery",
      );
    }

    const byKey = new Map(rows.map((row) => [row.key, row]));
    const ordered = AGENT_INVENTORY_KEYS.map((key) => byKey.get(key) ?? null);
    const prior = new Map((previous?.agents ?? []).map((agent) => [agent.key, agent]));

    // Seed each installed row from its prior values so a warm panel keeps
    // showing versions while they re-resolve; cold rows stay null and render as
    // skeletons.
    const working: AgentInventoryItem[] = ordered.map((item, index) => {
      const key = AGENT_INVENTORY_KEYS[index]!;
      if (!item) return unknownAgent(key);
      if (item.discoveryStatus === "missing") return missingAgent(item);
      const seed = prior.get(key);
      return installedAgent(
        item,
        seed?.currentVersion ?? null,
        seed?.latestVersion ?? null,
        seed?.updateStatus ?? "unknown",
        updateGuidance(item),
        null,
        "version",
      );
    });
    this.publishProgress(working, checkedAtMs);

    await Promise.all(ordered.map(async (item, index) => {
      if (!item || item.discoveryStatus === "missing") return;
      const guidance = updateGuidance(item);

      const currentVersion = await this.deps.probeVersion(item).catch(() => null);
      if (currentVersion === null) {
        working[index] = installedAgent(item, null, null, "unknown", guidance, "version", null);
        this.publishProgress(working, checkedAtMs);
        return;
      }

      // A version that moved invalidates whatever "latest" we were showing.
      const seed = prior.get(item.key);
      const carried = seed?.currentVersion === currentVersion ? seed.latestVersion : null;
      working[index] = installedAgent(
        item,
        currentVersion,
        carried,
        carried === null ? "unknown" : compareAgentVersions(item.key, currentVersion, carried),
        guidance,
        null,
        "latest",
      );
      this.publishProgress(working, checkedAtMs);

      const latest = await this.deps.resolveLatest(item)
        .catch((): LatestVersionResult => ({ version: null, packageName: null }));
      const resolvedGuidance = updateGuidance(item, latest.packageName);
      working[index] = latest.version === null
        ? installedAgent(item, currentVersion, null, "unknown", resolvedGuidance, "latest", null)
        : installedAgent(
          item,
          currentVersion,
          latest.version,
          compareAgentVersions(item.key, currentVersion, latest.version),
          resolvedGuidance,
          null,
          null,
        );
      this.publishProgress(working, checkedAtMs);
    }));

    return this.commit(working, checkedAtMs, null);
  }

  /** Emit-only interim state. Coalesced so a burst of completions sends once. */
  private publishProgress(agents: readonly AgentInventoryItem[], checkedAtMs: number): void {
    const next = buildSnapshot(agents.map(copyAgent), checkedAtMs, null, false);
    this.snapshot = next;
    this.pendingPublish = next;
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    queueMicrotask(() => {
      this.publishScheduled = false;
      this.flushPublish();
    });
  }

  private commit(
    agents: readonly AgentInventoryItem[],
    checkedAtMs: number,
    refreshError: string | null,
  ): AgentInventorySnapshot {
    const next = buildSnapshot(agents.map(copyAgent), checkedAtMs, refreshError, true);
    this.snapshot = next;
    this.deps.write(toPersisted(next));
    this.pendingPublish = next;
    this.flushPublish();
    return this.snapshot;
  }

  private flushPublish(): void {
    const next = this.pendingPublish;
    this.pendingPublish = null;
    if (!next || samePublishedContent(this.published, next)) return;
    this.published = copySnapshot(next);
    this.deps.emit(copySnapshot(next));
  }
}

function missingAgent(item: AgentInventoryProbeItem): AgentInventoryItem {
  return {
    key: item.key,
    displayName: item.displayName,
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

function unknownAgent(key: AgentInventoryKey): AgentInventoryItem {
  return {
    key,
    displayName: DISPLAY_NAMES[key],
    discoveryStatus: "unknown",
    resolvedBinary: null,
    resolvedAlias: null,
    currentVersion: null,
    latestVersion: null,
    updateStatus: "unknown",
    updateCommand: null,
    updateUrl: null,
    errorCode: "discovery",
    pendingPhase: null,
  };
}

function installedAgent(
  item: AgentInventoryProbeItem,
  currentVersion: string | null,
  latestVersion: string | null,
  updateStatus: AgentInventoryItem["updateStatus"],
  guidance: Pick<AgentInventoryItem, "updateCommand" | "updateUrl">,
  errorCode: AgentInventoryItem["errorCode"],
  pendingPhase: AgentInventoryItem["pendingPhase"],
): AgentInventoryItem {
  return {
    key: item.key,
    displayName: item.displayName,
    discoveryStatus: "installed",
    resolvedBinary: item.resolvedBinary,
    resolvedAlias: item.resolvedAlias,
    currentVersion,
    latestVersion,
    updateStatus,
    ...guidance,
    errorCode,
    pendingPhase,
  };
}

function buildSnapshot(
  agents: AgentInventoryItem[],
  checkedAtMs: number,
  refreshError: string | null,
  complete: boolean,
): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents,
    checkedAt: new Date(checkedAtMs).toISOString(),
    expiresAt: new Date(checkedAtMs + INVENTORY_TTL_MS).toISOString(),
    refreshError,
    complete,
  };
}

/** Timestamps alone are not worth waking the renderer for. */
function samePublishedContent(previous: AgentInventorySnapshot | null, next: AgentInventorySnapshot): boolean {
  return previous !== null
    && previous.refreshError === next.refreshError
    && previous.complete === next.complete
    && isDeepStrictEqual(previous.agents, next.agents);
}

function hydrate(snapshot: PersistedAgentInventorySnapshot): AgentInventorySnapshot {
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) => ({ ...agent, pendingPhase: null })),
    complete: true,
  };
}

function toPersisted(snapshot: AgentInventorySnapshot): PersistedAgentInventorySnapshot {
  const { complete: _complete, agents, ...rest } = snapshot;
  return {
    ...rest,
    agents: agents.map(({ pendingPhase: _pendingPhase, ...agent }) => agent),
  };
}

function copySnapshot(snapshot: AgentInventorySnapshot): AgentInventorySnapshot {
  return { ...snapshot, agents: snapshot.agents.map(copyAgent) };
}

function copyAgent(agent: AgentInventoryItem): AgentInventoryItem {
  return { ...agent };
}
