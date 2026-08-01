import { isDeepStrictEqual } from "node:util";
import type {
  AgentInventoryItem,
  AgentInventoryKey,
  AgentInventoryProbeItem,
  AgentInventorySnapshot,
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
  read: () => AgentInventorySnapshot | null;
  write: (snapshot: AgentInventorySnapshot) => void;
  emit: (snapshot: AgentInventorySnapshot) => void;
  now: () => number;
}

export class AgentInventoryService {
  private snapshot: AgentInventorySnapshot | null;
  private inFlight: Promise<AgentInventorySnapshot> | null = null;

  constructor(private readonly deps: AgentInventoryServiceDeps) {
    const cached = deps.read();
    this.snapshot = cached ? copySnapshot(cached) : null;
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
    if (this.snapshot && this.deps.now() - Date.parse(this.snapshot.checkedAt) < INVENTORY_TTL_MS) {
      return Promise.resolve(copySnapshot(this.snapshot));
    }
    return this.refresh();
  }

  private async runRefresh(): Promise<AgentInventorySnapshot> {
    const checkedAtMs = this.deps.now();
    let next: AgentInventorySnapshot;
    let discoveryRejected = true;
    try {
      const rows = await this.deps.probe();
      discoveryRejected = false;
      next = {
        schemaVersion: 1,
        agents: await this.resolveAgents(rows),
        checkedAt: new Date(checkedAtMs).toISOString(),
        expiresAt: new Date(checkedAtMs + INVENTORY_TTL_MS).toISOString(),
        refreshError: null,
      };
    } catch {
      if (discoveryRejected) {
        reportDiagnostic(this.deps, INVENTORY_DIAGNOSTIC_KEY, "discovery-rejected", checkedAtMs);
      }
      next = {
        schemaVersion: 1,
        agents: this.snapshot?.agents.map(copyAgent) ?? AGENT_INVENTORY_KEYS.map(unknownAgent),
        checkedAt: new Date(checkedAtMs).toISOString(),
        expiresAt: new Date(checkedAtMs + INVENTORY_TTL_MS).toISOString(),
        refreshError: "discovery",
      };
    }

    const changed = !samePublishedContent(this.snapshot, next);
    this.deps.write(copySnapshot(next));
    this.snapshot = copySnapshot(next);
    if (changed) this.deps.emit(copySnapshot(next));
    return this.snapshot;
  }

  private async resolveAgents(rows: AgentInventoryProbeItem[]): Promise<AgentInventoryItem[]> {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const ordered = AGENT_INVENTORY_KEYS.map((key) => byKey.get(key) ?? null);
    const currentVersions = await Promise.all(ordered.map(async (item) => {
      if (!item || item.discoveryStatus !== "available") return null;
      try {
        return await this.deps.probeVersion(item);
      } catch {
        return null;
      }
    }));

    return Promise.all(ordered.map(async (item, index) => {
      if (!item) return unknownAgent(AGENT_INVENTORY_KEYS[index]);
      if (item.discoveryStatus === "missing") return missingAgent(item);

      const currentVersion = currentVersions[index];
      const guidance = updateGuidance(item);
      if (currentVersion === null) {
        return installedAgent(item, currentVersion, null, "unknown", guidance, "version");
      }

      let latest: LatestVersionResult;
      try {
        latest = await this.deps.resolveLatest(item);
      } catch {
        latest = { version: null, packageName: null };
      }
      const resolvedGuidance = updateGuidance(item, latest.packageName);
      if (latest.version === null) {
        return installedAgent(item, currentVersion, null, "unknown", resolvedGuidance, "latest");
      }
      return installedAgent(
        item,
        currentVersion,
        latest.version,
        compareAgentVersions(item.key, currentVersion, latest.version),
        resolvedGuidance,
        null,
      );
    }));
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
  };
}

function installedAgent(
  item: AgentInventoryProbeItem,
  currentVersion: string | null,
  latestVersion: string | null,
  updateStatus: AgentInventoryItem["updateStatus"],
  guidance: Pick<AgentInventoryItem, "updateCommand" | "updateUrl">,
  errorCode: AgentInventoryItem["errorCode"],
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
  };
}

function samePublishedContent(previous: AgentInventorySnapshot | null, next: AgentInventorySnapshot): boolean {
  return previous !== null
    && previous.refreshError === next.refreshError
    && isDeepStrictEqual(previous.agents, next.agents);
}

function copySnapshot(snapshot: AgentInventorySnapshot): AgentInventorySnapshot {
  return { ...snapshot, agents: snapshot.agents.map(copyAgent) };
}

function copyAgent(agent: AgentInventoryItem): AgentInventoryItem {
  return { ...agent };
}
