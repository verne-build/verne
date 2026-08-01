import { execFile } from "node:child_process";
import type { AgentInventoryProbeItem } from "../../../src/types/agentInventory";
import {
  diagnosticStart,
  reportDiagnostic,
  type InventoryDiagnosticCode,
  type InventoryDiagnosticDeps,
} from "./diagnostics";

const MAX_HTTP_RESPONSE_BYTES = 1_048_576;
const MAX_CLI_OUTPUT_BYTES = 65_536;
const HTTP_TIMEOUT_MS = 4_000;
const CLI_TIMEOUT_MS = 5_000;
const SEMVER_SOURCE = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);
const PI_PACKAGE_NAME = /^@earendil-works\/[a-z0-9][a-z0-9._-]*$/;

const SOURCE_URLS = {
  "npm-json": new Set([
    "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest",
    "https://registry.npmjs.org/%40openai%2Fcodex/latest",
    "https://registry.npmjs.org/opencode-ai/latest",
  ]),
  "antigravity-installer": new Set(["https://antigravity.google/cli/install.sh"]),
  "cursor-installer": new Set(["https://cursor.com/install"]),
  "pi-json": new Set(["https://pi.dev/api/latest-version"]),
} as const;

export interface LatestVersionResult {
  version: string | null;
  packageName: string | null;
}

export interface LatestDeps extends InventoryDiagnosticDeps {
  fetch: typeof globalThis.fetch;
  execFile: typeof execFile;
  httpTimeoutMs: number;
  cliTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputBytes: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}

export const NODE_LATEST_DEPS: LatestDeps = {
  fetch: globalThis.fetch,
  execFile,
  httpTimeoutMs: HTTP_TIMEOUT_MS,
  cliTimeoutMs: CLI_TIMEOUT_MS,
  maxResponseBytes: MAX_HTTP_RESPONSE_BYTES,
  maxOutputBytes: MAX_CLI_OUTPUT_BYTES,
};

export async function resolveLatestVersion(
  item: AgentInventoryProbeItem,
  deps: LatestDeps,
): Promise<LatestVersionResult> {
  if (item.latestSource.kind === "grok-cli") {
    return { version: await resolveGrokVersion(item, deps), packageName: null };
  }

  const source = item.latestSource;
  const startedAt = diagnosticStart(deps);
  if (!isAllowedSourceUrl(source.kind, source.url)) return unknown();
  const fetched = await fetchText(item.key, source.url, startedAt, deps);
  if (fetched === null) return unknown();

  let result: LatestVersionResult;
  if (source.kind === "antigravity-installer") {
    result = { version: parseAntigravityInstaller(fetched), packageName: null };
  } else if (source.kind === "cursor-installer") {
    result = { version: parseCursorInstaller(fetched), packageName: null };
  } else {
    const value = parseJson(fetched);
    result = source.kind === "npm-json" ? npmResult(value) : piResult(value);
  }
  if (result.version === null) reportDiagnostic(deps, item.key, "latest-parse", startedAt);
  return result;
}

export function parseAntigravityInstaller(text: string): string | null {
  const version = text.match(/^VERSION=["']?([^"'\s]+)["']?$/m)?.[1];
  if (!validSemver(version)) return null;
  const escaped = escapeRegExp(version);
  const artifact = new RegExp(`^ARCHIVE_URL=["']?https://storage\\.googleapis\\.com/antigravity-cli/downloads/${escaped}/agy["']?$`, "m");
  const destination = new RegExp(`^DESTINATION=["']?[^"'\\n]*/agy-${escaped}["']?$`, "m");
  return artifact.test(text) && destination.test(text) ? version : null;
}

export function parseCursorInstaller(text: string): string | null {
  const download = text.match(/^DOWNLOAD_URL=["']?https:\/\/downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\/(?:\$\{OS\}|[a-z]+)\/(?:\$\{ARCH\}|[a-z0-9_]+)\/agent-cli-package\.tar\.gz["']?$/mi)?.[1];
  if (!download) return null;
  const destination = new RegExp(`^FINAL_DIR=["']?[^"'\\n]*/versions/${escapeRegExp(download)}["']?$`, "mi");
  return destination.test(text) ? download : null;
}

export function parseGrokUpdateCheck(output: string, currentVersion?: string | null): string | null {
  if (Buffer.byteLength(output, "utf8") > MAX_CLI_OUTPUT_BYTES) return null;
  const latest = output.match(new RegExp(`^Latest:\\s*(${SEMVER_SOURCE})\\s*$`, "m"))?.[1];
  if (validSemver(latest)) return latest;

  const current = output.match(new RegExp(`^Grok is up to date \\((${SEMVER_SOURCE})\\)\\s*$`))?.[1];
  if (validSemver(current)) return currentVersion && currentVersion !== current ? null : current;
  return /^Grok is up to date\s*$/.test(output) && validSemver(currentVersion) ? currentVersion : null;
}

function unknown(): LatestVersionResult {
  return { version: null, packageName: null };
}

function isAllowedSourceUrl(kind: keyof typeof SOURCE_URLS, url: string): boolean {
  return SOURCE_URLS[kind].has(url);
}

async function fetchText(
  key: AgentInventoryProbeItem["key"],
  url: string,
  startedAt: number,
  deps: LatestDeps,
): Promise<string | null> {
  const controller = new AbortController();
  const scheduleTimeout = deps.scheduleTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelTimeout = deps.cancelTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const timeout = scheduleTimeout(() => controller.abort(), deps.httpTimeoutMs);
  try {
    const response = await deps.fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      reportDiagnostic(deps, key, "latest-http-status", startedAt, response.status);
      return null;
    }
    const body = await readBody(response, deps.maxResponseBytes);
    if (body.kind === "ok") return body.text;
    reportDiagnostic(deps, key, body.kind === "cap" ? "latest-body-cap" : "latest-fetch", startedAt);
    return null;
  } catch {
    reportDiagnostic(deps, key, controller.signal.aborted ? "latest-fetch-timeout" : "latest-fetch", startedAt);
    return null;
  } finally {
    cancelTimeout(timeout);
  }
}

type BodyResult = { kind: "ok"; text: string } | { kind: "cap" } | { kind: "read" };

async function readBody(response: Response, maxBytes: number): Promise<BodyResult> {
  if (!response.body) return { kind: "read" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { kind: "cap" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "ok", text: new TextDecoder().decode(bytes) };
  } catch {
    return { kind: "read" };
  } finally {
    reader.releaseLock();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function npmResult(value: unknown): LatestVersionResult {
  if (!isRecord(value) || !validSemver(value.version)) return unknown();
  return { version: value.version, packageName: null };
}

function piResult(value: unknown): LatestVersionResult {
  if (!isRecord(value) || value.ok !== true || !validSemver(value.version)) return unknown();
  if (typeof value.packageName !== "string" || !PI_PACKAGE_NAME.test(value.packageName)) return unknown();
  return { version: value.version, packageName: value.packageName };
}

function resolveGrokVersion(item: AgentInventoryProbeItem, deps: LatestDeps): Promise<string | null> {
  if (item.discoveryStatus !== "available" || !item.resolvedBinary) return Promise.resolve(null);
  const binary = item.resolvedBinary;
  return new Promise((resolve) => {
    const startedAt = diagnosticStart(deps);
    try {
      deps.execFile(binary, ["update", "--check"], {
        shell: false,
        timeout: deps.cliTimeoutMs,
        maxBuffer: deps.maxOutputBytes,
      }, (error: Error | null, stdout: string) => {
        if (error) {
          reportDiagnostic(deps, item.key, grokFailureCode(error), startedAt);
          resolve(null);
          return;
        }
        if (typeof stdout !== "string") {
          reportDiagnostic(deps, item.key, "latest-cli-exec", startedAt);
          resolve(null);
          return;
        }
        if (Buffer.byteLength(stdout, "utf8") > deps.maxOutputBytes) {
          reportDiagnostic(deps, item.key, "latest-cli-output-cap", startedAt);
          resolve(null);
          return;
        }
        const version = parseGrokUpdateCheck(stdout);
        if (version === null) reportDiagnostic(deps, item.key, "latest-cli-parse", startedAt);
        resolve(version);
      });
    } catch {
      reportDiagnostic(deps, item.key, "latest-cli-exec", startedAt);
      resolve(null);
    }
  });
}

function grokFailureCode(error: unknown): InventoryDiagnosticCode {
  if (!isRecord(error)) return "latest-cli-exec";
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "latest-cli-output-cap";
  return error.killed === true ? "latest-cli-timeout" : "latest-cli-exec";
}

function validSemver(value: unknown): value is string {
  if (typeof value !== "string" || !SEMVER.test(value)) return false;
  const prerelease = value.match(/^\d+\.\d+\.\d+-([^+]+)/)?.[1];
  return !prerelease?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
