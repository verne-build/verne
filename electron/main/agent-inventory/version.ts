import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import type {
  AgentInventoryItem,
  AgentInventoryKey,
  AgentInventoryProbeItem,
  AgentUpdateStatus,
} from "../../../src/types/agentInventory";
import {
  diagnosticDuration,
  diagnosticStart,
  emitDiagnostic,
  reportDiagnostic,
  type InventoryDiagnosticCode,
  type InventoryDiagnosticDeps,
} from "./diagnostics";

const MAX_VERSION_OUTPUT_BYTES = 65_536;
const CODEX_PACKAGE = "@openai/codex";

export interface VersionDeps extends InventoryDiagnosticDeps {
  execFile: typeof execFile;
  timeoutMs: number;
  maxOutputBytes: number;
}

export const NODE_VERSION_DEPS: VersionDeps = {
  execFile,
  timeoutMs: 2_000,
  maxOutputBytes: MAX_VERSION_OUTPUT_BYTES,
};

export async function probeInstalledVersion(
  item: AgentInventoryProbeItem,
  deps: VersionDeps,
): Promise<string | null> {
  if (item.discoveryStatus !== "available" || !item.resolvedBinary) return null;

  const first = await probe(item, item.versionProbe.args, deps);
  const version = first === null ? null : parseInstalledVersion(item.key, first.output);
  if (version !== null) return version;
  if (first !== null) emitDiagnostic(deps, item.key, "version-parse", first.durationMs);

  if (item.versionProbe.kind !== "semver" || !item.versionProbe.fallback_args) return null;
  const fallback = await probe(item, item.versionProbe.fallback_args, deps);
  if (fallback === null) return null;
  const fallbackVersion = parseInstalledVersion(item.key, fallback.output);
  if (fallbackVersion === null) emitDiagnostic(deps, item.key, "version-parse", fallback.durationMs);
  return fallbackVersion;
}

export function parseInstalledVersion(key: AgentInventoryKey, output: string): string | null {
  if (Buffer.byteLength(output, "utf8") > MAX_VERSION_OUTPUT_BYTES) return null;
  const normalized = stripAnsi(output).trim();
  if (key === "cursor") return parseCursorBuild(normalized);

  const productPrefix = {
    claude: "(?:claude(?:\\s+code)?)",
    codex: "(?:codex(?:-cli|-rs|-tui)?)",
    antigravity: "(?:agy|antigravity(?:-cli)?)",
    grok: "(?:grok(?:\\s+version)?)",
    opencode: "(?:opencode|open-code)",
    pi: "pi",
  }[key];
  const suffix = key === "claude" ? "(?:\\s+\\(Claude Code\\))?" : "";
  const match = normalized.match(new RegExp(`^(?:${productPrefix}\\s+)?v?(${SEMVER_SOURCE})${suffix}$`, "i"));
  return match?.[1] && parseSemver(match[1]) ? match[1] : null;
}

export function compareAgentVersions(
  key: AgentInventoryKey,
  current: string | null,
  latest: string | null,
): AgentUpdateStatus {
  if (!current || !latest) return "unknown";
  if (key === "cursor") return compareCursorBuilds(current, latest);

  const currentSemver = parseSemver(current);
  const latestSemver = parseSemver(latest);
  if (!currentSemver || !latestSemver) return "unknown";
  return compareSemver(currentSemver, latestSemver) < 0 ? "outdated" : "current";
}

export function updateGuidance(
  item: AgentInventoryProbeItem,
  packageName: string | null = null,
): Pick<AgentInventoryItem, "updateCommand" | "updateUrl"> {
  // Pi supplies this validated value to retain package-scope migrations at the
  // call boundary. Its self-updater deliberately remains the displayed command.
  void packageName;

  if (item.update.kind === "command") {
    return { updateCommand: item.update.command, updateUrl: null };
  }
  if (item.update.kind === "resolved-alias") {
    return item.resolvedAlias
      ? { updateCommand: `${item.resolvedAlias} ${item.update.args.join(" ")}`, updateUrl: null }
      : { updateCommand: null, updateUrl: null };
  }

  const path = realExecutablePath(item.resolvedBinary);
  const command = path ? codexUpdateCommand(path) : null;
  return command
    ? { updateCommand: command, updateUrl: null }
    : { updateCommand: null, updateUrl: item.update.docs_url };
}

interface VersionProbeOutput {
  output: string;
  durationMs: number;
}

function probe(
  item: AgentInventoryProbeItem,
  args: readonly string[],
  deps: VersionDeps,
): Promise<VersionProbeOutput | null> {
  return new Promise((resolve) => {
    const startedAt = diagnosticStart(deps);
    try {
      deps.execFile(item.resolvedBinary!, args, {
        shell: false,
        timeout: deps.timeoutMs,
        maxBuffer: deps.maxOutputBytes,
      }, (error, stdout) => {
        if (error) {
          reportDiagnostic(deps, item.key, versionFailureCode(error), startedAt);
          resolve(null);
          return;
        }
        if (typeof stdout !== "string") {
          reportDiagnostic(deps, item.key, "version-exec", startedAt);
          resolve(null);
          return;
        }
        if (Buffer.byteLength(stdout, "utf8") > deps.maxOutputBytes) {
          reportDiagnostic(deps, item.key, "version-output-cap", startedAt);
          resolve(null);
          return;
        }
        resolve({ output: stdout, durationMs: diagnosticDuration(deps, startedAt) });
      });
    } catch {
      reportDiagnostic(deps, item.key, "version-exec", startedAt);
      resolve(null);
    }
  });
}

function versionFailureCode(error: unknown): InventoryDiagnosticCode {
  if (!isRecord(error)) return "version-exec";
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "version-output-cap";
  if (error.killed === true) return "version-timeout";
  if (typeof error.code === "number") return "version-nonzero";
  return "version-exec";
}

const SEMVER_SOURCE = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?";
const SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);

interface Semver {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[] | null;
}

function parseSemver(value: string): Semver | null {
  const match = value.match(SEMVER);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { major: match[1], minor: match[2], patch: match[3], prerelease };
}

function compareSemver(a: Semver, b: Semver): number {
  for (const field of ["major", "minor", "patch"] as const) {
    const comparison = compareNumericStrings(a[field], b[field]);
    if (comparison !== 0) return comparison;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return compareNumericStrings(left, right);
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseCursorBuild(value: string): string | null {
  const match = value.match(/^(?:(?:cursor|cursor-agent|agent)\s+)?(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)$/i);
  return match?.[1] ?? null;
}

function compareCursorBuilds(current: string, latest: string): AgentUpdateStatus {
  const currentBuild = parseCursorBuild(current);
  const latestBuild = parseCursorBuild(latest);
  if (!currentBuild || !latestBuild) return "unknown";
  if (currentBuild === latestBuild) return "current";
  const currentDate = currentBuild.slice(0, 10);
  const latestDate = latestBuild.slice(0, 10);
  if (currentDate === latestDate) return "unknown";
  return currentDate < latestDate ? "outdated" : "current";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function realExecutablePath(path: string | null): string | null {
  if (!path) return null;
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function codexUpdateCommand(path: string): string | null {
  if (path.includes("/.bun/")) return `bun update -g ${CODEX_PACKAGE}`;
  if (path.includes("/pnpm/") || path.includes("/.pnpm/")) return `pnpm update -g ${CODEX_PACKAGE}`;
  if (path.includes("/.vite-plus/")) return `vp update -g ${CODEX_PACKAGE}`;
  if (path.startsWith("/opt/homebrew/") || path.startsWith("/usr/local/Cellar/")) return "brew upgrade codex";
  if (path.includes("/node_modules/@openai/codex/")) return `npm update -g ${CODEX_PACKAGE}`;
  return null;
}
