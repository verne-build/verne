import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentInventoryProbeItem } from "../../../src/types/agentInventory";
import type { AgentInventoryKey } from "../../../src/types/agentInventory";
import {
  compareAgentVersions,
  parseInstalledVersion,
  probeInstalledVersion,
  updateGuidance,
  type VersionDeps,
} from "./version";

function probeItem(
  key: AgentInventoryKey,
  versionProbe: AgentInventoryProbeItem["versionProbe"],
  resolvedBinary = "/opt/tools/agent",
): AgentInventoryProbeItem {
  return {
    key,
    displayName: key,
    discoveryStatus: "available",
    resolvedBinary,
    resolvedAlias: key,
    versionProbe,
    latestSource: { kind: "grok-cli" },
    update: { kind: "command", command: `${key} update` },
  };
}

function depsFor(
  responses: Array<string | Error>,
  onCall?: (args: readonly string[], options: unknown) => void,
): VersionDeps {
  return {
    timeoutMs: 20,
    maxOutputBytes: 65_536,
    execFile: ((_: string, args: readonly string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      onCall?.(args, options);
      const response = responses.shift() ?? new Error("unexpected probe");
      queueMicrotask(() => callback(response instanceof Error ? response : null, response instanceof Error ? "" : response, ""));
      return {} as ChildProcess;
    }) as VersionDeps["execFile"],
  };
}

describe("installed agent versions", () => {
  it.each([
    ["claude", "2.1.4 (Claude Code)", "2.1.4"],
    ["codex", "codex-cli 0.44.1", "0.44.1"],
    ["antigravity", "agy 1.8.0", "1.8.0"],
    ["grok", "grok version 0.9.2", "0.9.2"],
    ["opencode", "1.2.3", "1.2.3"],
    ["pi", "pi 0.83.0", "0.83.0"],
  ])("parses %s version output", (key, stdout, expected) => {
    expect(parseInstalledVersion(key as AgentInventoryKey, stdout)).toBe(expected);
  });

  it("accepts ANSI output and rejects non-versions and oversized output", () => {
    expect(parseInstalledVersion("claude", "\u001b[32m2.1.4\u001b[0m")).toBe("2.1.4");
    expect(parseInstalledVersion("claude", "release 21")).toBeNull();
    expect(parseInstalledVersion("claude", "x".repeat(65_537))).toBeNull();
  });

  it("compares semver prereleases and Cursor builds conservatively", () => {
    expect(compareAgentVersions("claude", "2.1.4-beta.1", "2.1.4")).toBe("outdated");
    expect(compareAgentVersions("cursor", "2026.07.30-a1", "2026.07.31-b2")).toBe("outdated");
    expect(compareAgentVersions("cursor", "2026.07.31-a1", "2026.07.31-b2")).toBe("unknown");
  });

  it("falls back when a probe's primary invocation fails", async () => {
    const piProbe = probeItem("pi", {
      kind: "semver",
      args: ["--version"],
      fallback_args: ["-v"],
    });

    await expect(probeInstalledVersion(piProbe, depsFor([new Error("unsupported"), "pi 0.83.0"]))).resolves.toBe("0.83.0");
    await expect(probeInstalledVersion(piProbe, depsFor(["unrecognized option", "pi 0.83.0"]))).resolves.toBe("0.83.0");
  });

  it("returns null on process errors and timeouts", async () => {
    const claudeProbe = probeItem("claude", {
      kind: "semver",
      args: ["--version"],
      fallback_args: null,
    });
    const piProbe = probeItem("pi", {
      kind: "semver",
      args: ["--version"],
      fallback_args: ["-v"],
    });

    await expect(probeInstalledVersion(claudeProbe, depsFor([new Error("exit 1")]))).resolves.toBeNull();
    await expect(probeInstalledVersion(piProbe, depsFor([new Error("ETIMEDOUT"), new Error("ETIMEDOUT")]))).resolves.toBeNull();
  });

  it("executes resolved binaries without a shell and with bounded output", async () => {
    const claudeProbe = probeItem("claude", {
      kind: "semver",
      args: ["--version"],
      fallback_args: null,
    });
    const calls: Array<{ args: readonly string[]; options: unknown }> = [];

    await expect(probeInstalledVersion(claudeProbe, depsFor(["2.1.4"], (args, options) => calls.push({ args, options })))).resolves.toBe("2.1.4");
    expect(calls).toEqual([{ args: ["--version"], options: { shell: false, timeout: 20, maxBuffer: 65_536 } }]);
  });

  it("returns native and conservative update guidance", () => {
    expect(updateGuidance(probeItem("claude", { kind: "semver", args: [], fallback_args: null }))).toEqual({ updateCommand: "claude update", updateUrl: null });
    expect(updateGuidance(probeItem("cursor", { kind: "cursor-build", args: [] }))).toEqual({ updateCommand: "cursor update", updateUrl: null });
    const codex = probeItem("codex", { kind: "codex", args: [] }, "/not/a/known/layout/codex");
    codex.update = { kind: "codex-install-path", docs_url: "https://github.com/openai/codex" };
    expect(updateGuidance(codex)).toEqual({ updateCommand: null, updateUrl: "https://github.com/openai/codex" });
  });

  it("uses Vite+'s global updater for a real Vite+ executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "verne-version-"));
    const binary = join(root, ".vite-plus", "packages", "node_modules", "@openai", "codex", "bin", "codex");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n");
    const codex = probeItem("codex", { kind: "codex", args: [] }, binary);
    codex.update = { kind: "codex-install-path", docs_url: "https://github.com/openai/codex" };

    try {
      expect(updateGuidance(codex)).toEqual({ updateCommand: "vp update -g @openai/codex", updateUrl: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["node_modules/@openai/codex/bin/codex", "npm update -g @openai/codex"],
    ["pnpm/global/node_modules/@openai/codex/bin/codex", "pnpm update -g @openai/codex"],
    [".bun/install/global/node_modules/@openai/codex/bin/codex", "bun update -g @openai/codex"],
  ])("uses the owning package manager for %s", async (relativePath, updateCommand) => {
    const root = await mkdtemp(join(tmpdir(), "verne-version-"));
    const binary = join(root, relativePath);
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n");
    const codex = probeItem("codex", { kind: "codex", args: [] }, binary);
    codex.update = { kind: "codex-install-path", docs_url: "https://github.com/openai/codex" };

    try {
      expect(updateGuidance(codex)).toEqual({ updateCommand, updateUrl: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
