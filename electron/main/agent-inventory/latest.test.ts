import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AgentInventoryKey, AgentInventoryProbeItem } from "../../../src/types/agentInventory";
import {
  parseAntigravityInstaller,
  parseCursorInstaller,
  parseGrokUpdateCheck,
  resolveLatestVersion,
  type LatestDeps,
} from "./latest";

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const antigravityFixture = await fixture("antigravity-install.sh");
const cursorFixture = await fixture("cursor-install.sh");
const grokCurrentFixture = await fixture("grok-update-current.txt");
const grokOutdatedFixture = await fixture("grok-update-outdated.txt");

function probeItem(
  key: AgentInventoryKey,
  latestSource: AgentInventoryProbeItem["latestSource"],
  resolvedBinary = "/opt/tools/agent",
): AgentInventoryProbeItem {
  return {
    key,
    displayName: key,
    discoveryStatus: "available",
    resolvedBinary,
    resolvedAlias: key,
    versionProbe: { kind: "semver", args: ["--version"], fallback_args: null },
    latestSource,
    update: { kind: "command", command: `${key} update` },
  };
}

const claudeProbe = probeItem("claude", {
  kind: "npm-json",
  url: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest",
});
const piProbe = probeItem("pi", { kind: "pi-json", url: "https://pi.dev/api/latest-version" });
const grokProbe = probeItem("grok", { kind: "grok-cli" }, "/opt/tools/grok");

function depsWithResponse(body: unknown): LatestDeps {
  return depsWithBody(JSON.stringify(body));
}

function depsWithStatus(status: number): LatestDeps {
  return depsFor(async () => new Response("", { status }));
}

function depsThatAbort(): LatestDeps {
  return depsFor(async (_url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    throw new DOMException("aborted", "AbortError");
  });
}

function depsWithBody(body: string): LatestDeps {
  return depsFor(async () => new Response(body, { status: 200 }));
}

function depsFor(fetch: LatestDeps["fetch"]): LatestDeps {
  return {
    fetch,
    execFile: ((_: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      queueMicrotask(() => callback(null, grokOutdatedFixture, ""));
      return {} as ChildProcess;
    }) as LatestDeps["execFile"],
    httpTimeoutMs: 20,
    cliTimeoutMs: 20,
    maxResponseBytes: 1_048_576,
    maxOutputBytes: 65_536,
  };
}

describe("latest agent versions", () => {
  it("reads the stable version from npm latest JSON", async () => {
    const result = await resolveLatestVersion(claudeProbe, depsWithResponse({ version: "2.1.4" }));
    expect(result).toEqual({ version: "2.1.4", packageName: null });
  });

  it("rejects failed, aborted, oversized, and malformed npm responses", async () => {
    await expect(resolveLatestVersion(claudeProbe, depsWithStatus(503))).resolves.toEqual({ version: null, packageName: null });
    await expect(resolveLatestVersion(claudeProbe, depsThatAbort())).resolves.toEqual({ version: null, packageName: null });
    await expect(resolveLatestVersion(claudeProbe, depsWithBody("x".repeat(1_048_577)))).resolves.toEqual({ version: null, packageName: null });
    await expect(resolveLatestVersion(claudeProbe, depsWithBody("{"))).resolves.toEqual({ version: null, packageName: null });
    await expect(resolveLatestVersion(claudeProbe, depsWithResponse({ version: "2.1.4-01" }))).resolves.toEqual({ version: null, packageName: null });
  });

  it("rejects non-registry HTTPS source URLs", async () => {
    const unsafe = probeItem("claude", { kind: "npm-json", url: "https://example.com/latest" });
    let fetched = false;
    const deps = depsFor(async () => {
      fetched = true;
      return new Response(JSON.stringify({ version: "2.1.4" }));
    });

    await expect(resolveLatestVersion(unsafe, deps)).resolves.toEqual({ version: null, packageName: null });
    expect(fetched).toBe(false);
  });

  it("requires matching Antigravity release metadata and artifact versions", () => {
    expect(parseAntigravityInstaller(antigravityFixture)).toBe("1.8.0");
    expect(parseAntigravityInstaller(
      antigravityFixture.replace("downloads/1.8.0/agy", "downloads/1.8.1/agy"),
    )).toBeNull();
  });

  it("requires matching Cursor download and install identifiers", () => {
    expect(parseCursorInstaller(cursorFixture)).toBe("2026.07.31-a1b2c3");
    expect(parseCursorInstaller(cursorFixture.replace("a1b2c3", "different"))).toBeNull();
  });

  it("preserves Pi package scope", async () => {
    const result = await resolveLatestVersion(piProbe, depsWithResponse({
      ok: true,
      version: "0.83.0",
      packageName: "@earendil-works/pi-coding-agent",
    }));
    expect(result).toEqual({ version: "0.83.0", packageName: "@earendil-works/pi-coding-agent" });
  });

  it("rejects unscoped Pi package data", async () => {
    await expect(resolveLatestVersion(piProbe, depsWithResponse({
      ok: true,
      version: "0.83.0",
      packageName: "unscoped",
    }))).resolves.toEqual({ version: null, packageName: null });
  });

  it("parses only labelled or explicit-current Grok update responses", async () => {
    expect(parseGrokUpdateCheck(grokOutdatedFixture)).toBe("0.9.2");
    expect(parseGrokUpdateCheck(grokCurrentFixture, "0.9.2")).toBe("0.9.2");
    expect(parseGrokUpdateCheck("Downloaded 12 files in 3 seconds")).toBeNull();
  });

  it("checks Grok's resolved executable without a shell", async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
    const deps = depsWithResponse({ version: "ignored" });
    deps.execFile = ((file: string, args: readonly string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      calls.push({ file, args, options });
      queueMicrotask(() => callback(null, grokOutdatedFixture, ""));
      return {} as ChildProcess;
    }) as LatestDeps["execFile"];

    await expect(resolveLatestVersion(grokProbe, deps)).resolves.toEqual({ version: "0.9.2", packageName: null });
    expect(calls).toEqual([{
      file: "/opt/tools/grok",
      args: ["update", "--check"],
      options: { shell: false, timeout: 20, maxBuffer: 65_536 },
    }]);
  });
});
