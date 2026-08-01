import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInventoryItem, AgentInventorySnapshot } from "../../../src/types/agentInventory";
import { AGENT_INVENTORY_KEYS, readSnapshot, validateSnapshot, writeSnapshot } from "./store";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const roots: string[] = [];

function item(key: AgentInventoryItem["key"]): AgentInventoryItem {
  return {
    key,
    displayName: key,
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

function snapshot(): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents: AGENT_INVENTORY_KEYS.map(item),
    checkedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-01T01:00:00.000Z",
    refreshError: null,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent inventory snapshot storage", () => {
  it("accepts the exact seven-row wire shape in registry order", () => {
    const value = snapshot();

    expect(validateSnapshot(value, NOW)).toEqual(value);
  });

  it("accepts expiry exactly one hour after the check", () => {
    const value = snapshot();

    expect(Date.parse(value.expiresAt) - Date.parse(value.checkedAt)).toBe(3_600_000);
    expect(validateSnapshot(value, NOW)).toEqual(value);
  });

  it.each([
    ["wrong schema", { ...snapshot(), schemaVersion: 2 }],
    ["duplicate key", { ...snapshot(), agents: [...snapshot().agents.slice(0, 6), snapshot().agents[0]] }],
    ["missing key", { ...snapshot(), agents: snapshot().agents.slice(0, 6) }],
    ["wrong order", { ...snapshot(), agents: [snapshot().agents[1], snapshot().agents[0], ...snapshot().agents.slice(2)] }],
    ["malformed discovery enum", { ...snapshot(), agents: snapshot().agents.map((agent, index) => index === 0 ? { ...agent, discoveryStatus: "available" } : agent) }],
    ["malformed update enum", { ...snapshot(), agents: snapshot().agents.map((agent, index) => index === 0 ? { ...agent, updateStatus: "newer" } : agent) }],
    ["malformed error enum", { ...snapshot(), agents: snapshot().agents.map((agent, index) => index === 0 ? { ...agent, errorCode: "timeout" } : agent) }],
    ["non-ISO checked timestamp", { ...snapshot(), checkedAt: "2026-08-01 00:00:00Z" }],
    ["non-ISO expiry timestamp", { ...snapshot(), expiresAt: "2026-08-01T01:00:00Z" }],
    ["backwards expiry", { ...snapshot(), expiresAt: "2026-07-31T23:59:59.999Z" }],
    ["expiry before one hour", { ...snapshot(), expiresAt: "2026-08-01T00:59:59.999Z" }],
    ["expiry after one hour", { ...snapshot(), expiresAt: "2026-08-01T01:00:00.001Z" }],
    ["future timestamp", { ...snapshot(), checkedAt: "2026-08-01T00:05:00.001Z" }],
    ["extra snapshot field", { ...snapshot(), unexpected: true }],
    ["extra agent field", { ...snapshot(), agents: snapshot().agents.map((agent, index) => index === 0 ? { ...agent, unexpected: true } : agent) }],
  ])("rejects %s", (_label, value) => {
    expect(validateSnapshot(value, NOW)).toBeNull();
  });

  it("allows a checked timestamp exactly five minutes ahead", () => {
    const value = {
      ...snapshot(),
      checkedAt: "2026-08-01T00:05:00.000Z",
      expiresAt: "2026-08-01T01:05:00.000Z",
    };

    expect(validateSnapshot(value, NOW)).toEqual(value);
  });

  it("reads valid JSON and treats missing or malformed files as cache misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "verne-inventory-store-"));
    roots.push(root);
    const path = join(root, "inventory.json");

    expect(readSnapshot(path, NOW)).toBeNull();
    await writeFile(path, "{");
    expect(readSnapshot(path, NOW)).toBeNull();
    await writeFile(path, JSON.stringify(snapshot()));
    expect(readSnapshot(path, NOW)).toEqual(snapshot());
  });

  it("atomically replaces the snapshot without leaving a sibling temp file", async () => {
    const root = await mkdtemp(join(tmpdir(), "verne-inventory-store-"));
    roots.push(root);
    const path = join(root, "inventory.json");

    writeSnapshot(path, snapshot());

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(snapshot());
    expect((await readdir(root)).filter((name) => name.includes(".tmp."))).toEqual([]);
  });
});
