import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AgentDiscoveryStatus,
  AgentInventoryItem,
  AgentInventoryKey,
  AgentInventorySnapshot,
  AgentUpdateStatus,
} from "../../../src/types/agentInventory";

const MAX_FUTURE_MS = 5 * 60 * 1_000;
const SNAPSHOT_FIELDS = ["schemaVersion", "agents", "checkedAt", "expiresAt", "refreshError"];
const AGENT_FIELDS = [
  "key",
  "displayName",
  "discoveryStatus",
  "resolvedBinary",
  "resolvedAlias",
  "currentVersion",
  "latestVersion",
  "updateStatus",
  "updateCommand",
  "updateUrl",
  "errorCode",
];
const DISCOVERY_STATUSES = new Set<AgentDiscoveryStatus>(["installed", "missing", "unknown"]);
const UPDATE_STATUSES = new Set<AgentUpdateStatus>(["current", "outdated", "unknown"]);
const ERROR_CODES = new Set<AgentInventoryItem["errorCode"]>([null, "discovery", "version", "latest"]);

export const AGENT_INVENTORY_KEYS: readonly AgentInventoryKey[] = [
  "claude",
  "codex",
  "antigravity",
  "cursor",
  "grok",
  "opencode",
  "pi",
];

export function validateSnapshot(value: unknown, nowMs: number): AgentInventorySnapshot | null {
  if (!isRecord(value) || !hasExactFields(value, SNAPSHOT_FIELDS)) return null;
  if (value.schemaVersion !== 1 || !Array.isArray(value.agents)) return null;
  if (value.agents.length !== AGENT_INVENTORY_KEYS.length) return null;
  if (typeof value.refreshError !== "string" && value.refreshError !== null) return null;

  const checkedAt = parseIso(value.checkedAt);
  if (checkedAt === null || checkedAt > nowMs + MAX_FUTURE_MS) return null;
  if (parseIso(value.expiresAt) === null) return null;

  for (let index = 0; index < AGENT_INVENTORY_KEYS.length; index++) {
    if (!isAgent(value.agents[index], AGENT_INVENTORY_KEYS[index])) return null;
  }
  return value as unknown as AgentInventorySnapshot;
}

export function readSnapshot(path: string, nowMs: number): AgentInventorySnapshot | null {
  try {
    return validateSnapshot(JSON.parse(readFileSync(path, "utf8")), nowMs);
  } catch {
    return null;
  }
}

export function writeSnapshot(path: string, snapshot: AgentInventorySnapshot): void {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.tmp.${process.pid}`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isAgent(value: unknown, expectedKey: AgentInventoryKey): value is AgentInventoryItem {
  if (!isRecord(value) || !hasExactFields(value, AGENT_FIELDS)) return false;
  return value.key === expectedKey
    && typeof value.displayName === "string"
    && DISCOVERY_STATUSES.has(value.discoveryStatus as AgentDiscoveryStatus)
    && nullableString(value.resolvedBinary)
    && nullableString(value.resolvedAlias)
    && nullableString(value.currentVersion)
    && nullableString(value.latestVersion)
    && UPDATE_STATUSES.has(value.updateStatus as AgentUpdateStatus)
    && nullableString(value.updateCommand)
    && nullableString(value.updateUrl)
    && ERROR_CODES.has(value.errorCode as AgentInventoryItem["errorCode"]);
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function nullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function hasExactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const fields = Object.keys(value);
  return fields.length === expected.length && expected.every((field) => Object.hasOwn(value, field));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
