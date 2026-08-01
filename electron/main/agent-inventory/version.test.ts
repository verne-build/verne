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
  it("pins sanitized diagnostics for exec, timeout, output-cap, parse, and nonzero failures", async () => {
    const events: unknown[] = [];
    const binary = "/Users/alice/private/bin/claude";
    const rawExecError = "PRIVATE_EXEC_ERROR ENV_TOKEN=secret";
    const rawTimeoutError = "PRIVATE_TIMEOUT_ERROR";
    const rawNonzeroError = "PRIVATE_NONZERO_ERROR";
    const rawOutput = "PRIVATE_STDOUT_AND_STDERR";
    const probe = probeItem("claude", {
      kind: "semver",
      args: ["--version"],
      fallback_args: null,
    }, binary);

    const run = async (
      error: (Error & { code?: string | number; killed?: boolean }) | null,
      stdout: string,
      stderr: string,
      clock: number[],
      maxOutputBytes = 65_536,
    ) => {
      const deps = Object.assign({
        timeoutMs: 20,
        maxOutputBytes,
        execFile: ((_: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
          queueMicrotask(() => callback(error, stdout, stderr));
          return {} as ChildProcess;
        }) as VersionDeps["execFile"],
      }, {
        diagnostic: (event: unknown) => events.push(event),
        now: () => clock.shift() ?? 0,
      });
      await probeInstalledVersion(probe, deps);
    };

    await run(Object.assign(new Error(rawExecError), { code: "ENOENT" }), "", "PRIVATE_STDERR", [100, 108]);
    await run(Object.assign(new Error(rawTimeoutError), { killed: true }), "", "", [200, 213]);
    await run(null, rawOutput, "PRIVATE_STDERR", [300, 315], 4);
    await run(null, "not-semver", "PRIVATE_STDERR", [400, 390]);
    await run(Object.assign(new Error(rawNonzeroError), { code: 7 }), "PRIVATE_NONZERO_STDOUT", "PRIVATE_STDERR", [500, 521]);

    expect(events).toEqual([
      { key: "claude", code: "version-exec", durationMs: 8, httpStatus: null },
      { key: "claude", code: "version-timeout", durationMs: 13, httpStatus: null },
      { key: "claude", code: "version-output-cap", durationMs: 15, httpStatus: null },
      { key: "claude", code: "version-parse", durationMs: 0, httpStatus: null },
      { key: "claude", code: "version-nonzero", durationMs: 21, httpStatus: null },
    ]);
    const serialized = JSON.stringify(events);
    for (const secret of [binary, rawExecError, rawTimeoutError, rawNonzeroError, rawOutput, "PRIVATE_STDERR", "ENV_TOKEN=secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not diagnose successful probes or ordinary missing agents", async () => {
    const events: unknown[] = [];
    const available = probeItem("claude", {
      kind: "semver",
      args: ["--version"],
      fallback_args: null,
    });
    const missing = { ...available, discoveryStatus: "missing" as const, resolvedBinary: null };
    const deps = Object.assign(depsFor(["2.1.4"]), {
      diagnostic: (event: unknown) => events.push(event),
      now: viClock([100, 101]),
    });

    await expect(probeInstalledVersion(available, deps)).resolves.toBe("2.1.4");
    await expect(probeInstalledVersion(missing, deps)).resolves.toBeNull();
    expect(events).toEqual([]);
  });

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
    expect(parseInstalledVersion("claude", "2.1.4 garbage")).toBeNull();
    expect(parseInstalledVersion("claude", "2.1.4 (")).toBeNull();
    expect(parseInstalledVersion("claude", "x".repeat(65_537))).toBeNull();
  });

  it("compares semver prereleases and Cursor builds conservatively", () => {
    expect(compareAgentVersions("claude", "2.1.4-beta.1", "2.1.4")).toBe("outdated");
    expect(compareAgentVersions("cursor", "2026.07.30-a1", "2026.07.31-b2")).toBe("outdated");
    expect(compareAgentVersions("cursor", "2026.07.31-a1", "2026.07.31-b2")).toBe("unknown");
  });

  it("orders large semver core and prerelease identifiers exactly", () => {
    expect(compareAgentVersions("claude", "9007199254740992.0.0", "9007199254740993.0.0")).toBe("outdated");
    expect(compareAgentVersions("claude", "1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe("outdated");
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

function viClock(values: number[]): () => number {
  return () => values.shift() ?? 0;
}
