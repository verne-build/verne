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
  it("pins sanitized HTTP diagnostics with status only on non-OK responses", async () => {
    const events: unknown[] = [];
    const rawStatusBody = "PRIVATE_STATUS_BODY";
    const rawFetchError = "PRIVATE_FETCH_ERROR URL=https://secret.example/user";
    const rawCapBody = "PRIVATE_BODY_CAP";
    const rawPackageName = "PRIVATE_PACKAGE_NAME";
    const rawParseBody = JSON.stringify({ packageName: rawPackageName });
    const instrument = (deps: LatestDeps, clock: number[], timer?: (callback: () => void) => unknown) => Object.assign(
      deps,
      {
        diagnostic: (event: unknown) => events.push(event),
        now: () => clock.shift() ?? 0,
      },
      timer ? { scheduleTimeout: timer, cancelTimeout: () => {} } : {},
    );

    await resolveLatestVersion(claudeProbe, instrument(
      depsFor(async () => new Response(rawStatusBody, { status: 503 })),
      [100, 109],
    ));
    await resolveLatestVersion(claudeProbe, instrument(
      depsFor(async () => { throw new Error(rawFetchError); }),
      [200, 211],
    ));
    await resolveLatestVersion(claudeProbe, instrument(
      depsFor(async (_url, init) => {
        if (!init?.signal?.aborted) throw new Error("timer seam did not abort");
        throw new DOMException("PRIVATE_ABORT_ERROR", "AbortError");
      }),
      [300, 313],
      (callback) => { callback(); return 1; },
    ));
    const capped = depsWithBody(rawCapBody);
    capped.maxResponseBytes = 4;
    await resolveLatestVersion(claudeProbe, instrument(capped, [400, 417]));
    await resolveLatestVersion(claudeProbe, instrument(depsWithBody(rawParseBody), [500, 519]));

    expect(events).toEqual([
      { key: "claude", code: "latest-http-status", durationMs: 9, httpStatus: 503 },
      { key: "claude", code: "latest-fetch", durationMs: 11, httpStatus: null },
      { key: "claude", code: "latest-fetch-timeout", durationMs: 13, httpStatus: null },
      { key: "claude", code: "latest-body-cap", durationMs: 17, httpStatus: null },
      { key: "claude", code: "latest-parse", durationMs: 19, httpStatus: null },
    ]);
    const serialized = JSON.stringify(events);
    for (const secret of [rawStatusBody, rawFetchError, rawCapBody, rawParseBody, rawPackageName, "https://secret.example/user", "PRIVATE_ABORT_ERROR"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("pins sanitized Grok CLI diagnostics for timeout, exec, output-cap, and parse failures", async () => {
    const events: unknown[] = [];
    const binary = "/Users/alice/private/bin/grok";
    const rawOutput = "PRIVATE_GROK_OUTPUT";
    const probe = { ...grokProbe, resolvedBinary: binary };
    const run = async (
      error: (Error & { killed?: boolean; code?: string | number }) | null,
      stdout: string,
      clock: number[],
      maxOutputBytes = 65_536,
    ) => {
      const deps = depsFor(async () => { throw new Error("fetch must not run"); });
      deps.maxOutputBytes = maxOutputBytes;
      deps.execFile = ((_: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        queueMicrotask(() => callback(error, stdout, "PRIVATE_GROK_STDERR"));
        return {} as ChildProcess;
      }) as LatestDeps["execFile"];
      await resolveLatestVersion(probe, Object.assign(deps, {
        diagnostic: (event: unknown) => events.push(event),
        now: () => clock.shift() ?? 0,
      }));
    };

    await run(Object.assign(new Error("PRIVATE_GROK_TIMEOUT"), { killed: true }), "", [100, 106]);
    await run(Object.assign(new Error("PRIVATE_GROK_EXEC"), { code: "ENOENT" }), "", [200, 207]);
    await run(null, rawOutput, [300, 308], 4);
    await run(null, "unlabelled release text", [400, 409]);

    expect(events).toEqual([
      { key: "grok", code: "latest-cli-timeout", durationMs: 6, httpStatus: null },
      { key: "grok", code: "latest-cli-exec", durationMs: 7, httpStatus: null },
      { key: "grok", code: "latest-cli-output-cap", durationMs: 8, httpStatus: null },
      { key: "grok", code: "latest-cli-parse", durationMs: 9, httpStatus: null },
    ]);
    const serialized = JSON.stringify(events);
    for (const secret of [binary, rawOutput, "PRIVATE_GROK_TIMEOUT", "PRIVATE_GROK_EXEC", "PRIVATE_GROK_STDERR"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not diagnose successful latest checks", async () => {
    const events: unknown[] = [];
    const deps = Object.assign(depsWithResponse({ version: "2.1.4" }), {
      diagnostic: (event: unknown) => events.push(event),
      now: viClock([100, 101]),
    });

    await expect(resolveLatestVersion(claudeProbe, deps)).resolves.toEqual({ version: "2.1.4", packageName: null });
    expect(events).toEqual([]);
  });

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

  it("refuses redirecting registry requests", async () => {
    let options: RequestInit | undefined;
    const deps = depsFor(async (_url, init) => {
      options = init;
      throw new TypeError("redirect refused");
    });

    await expect(resolveLatestVersion(claudeProbe, deps)).resolves.toEqual({ version: null, packageName: null });
    expect(options).toMatchObject({ redirect: "error" });
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

  it.each([
    "@earendil-works/",
    "@earendil-works/foo bar",
    "@earendil-works/../../other",
  ])("rejects malformed vendor-scoped Pi package names: %s", async (packageName) => {
    await expect(resolveLatestVersion(piProbe, depsWithResponse({
      ok: true,
      version: "0.83.0",
      packageName,
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

function viClock(values: number[]): () => number {
  return () => values.shift() ?? 0;
}
