export type AgentInventoryKey =
  | "claude"
  | "codex"
  | "antigravity"
  | "cursor"
  | "grok"
  | "opencode"
  | "pi";

export type AgentDiscoveryStatus = "installed" | "missing" | "unknown";
export type AgentUpdateStatus = "current" | "outdated" | "unknown";

/** Slow field this row is still resolving. Transient — never persisted. */
export type AgentPendingPhase = "version" | "latest" | null;

export interface AgentInventoryItem {
  key: AgentInventoryKey;
  displayName: string;
  discoveryStatus: AgentDiscoveryStatus;
  resolvedBinary: string | null;
  resolvedAlias: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  updateStatus: AgentUpdateStatus;
  updateCommand: string | null;
  updateUrl: string | null;
  errorCode: "discovery" | "version" | "latest" | null;
  /** Transient. Stripped before persistence, defaulted to null on read. */
  pendingPhase: AgentPendingPhase;
}

export interface AgentInventorySnapshot {
  schemaVersion: 1;
  agents: AgentInventoryItem[];
  checkedAt: string;
  expiresAt: string;
  refreshError: string | null;
  /** False while a refresh is still resolving rows. Transient — never persisted. */
  complete: boolean;
}

/** On-disk shape: the snapshot without its transient progress fields. */
export type PersistedAgentInventoryItem = Omit<AgentInventoryItem, "pendingPhase">;
export type PersistedAgentInventorySnapshot =
  Omit<AgentInventorySnapshot, "agents" | "complete"> & { agents: PersistedAgentInventoryItem[] };

export type VersionProbe =
  | { kind: "semver"; args: string[]; fallback_args: string[] | null }
  | { kind: "codex"; args: string[] }
  | { kind: "cursor-build"; args: string[] };

export type LatestVersionSource =
  | { kind: "npm-json"; url: string }
  | { kind: "antigravity-installer"; url: string }
  | { kind: "cursor-installer"; url: string }
  | { kind: "grok-cli" }
  | { kind: "pi-json"; url: string };

export type UpdateGuidance =
  | { kind: "command"; command: string }
  | { kind: "codex-install-path"; docs_url: string }
  | { kind: "resolved-alias"; args: string[] };

/** Rust's direct discovery row, before Electron derives UI-facing status. */
export interface AgentInventoryProbeItem {
  key: AgentInventoryKey;
  displayName: string;
  discoveryStatus: "available" | "missing";
  resolvedBinary: string | null;
  resolvedAlias: string | null;
  versionProbe: VersionProbe;
  latestSource: LatestVersionSource;
  update: UpdateGuidance;
}
