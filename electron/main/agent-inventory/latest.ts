import { execFile } from "node:child_process";
import type { AgentInventoryProbeItem } from "../../../src/types/agentInventory";

const MAX_HTTP_RESPONSE_BYTES = 1_048_576;
const MAX_CLI_OUTPUT_BYTES = 65_536;
const HTTP_TIMEOUT_MS = 4_000;
const CLI_TIMEOUT_MS = 5_000;
const SEMVER_SOURCE = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);

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

export interface LatestDeps {
  fetch: typeof globalThis.fetch;
  execFile: typeof execFile;
  httpTimeoutMs: number;
  cliTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputBytes: number;
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
  if (!isAllowedSourceUrl(source.kind, source.url)) return unknown();
  const text = await fetchText(source.url, deps);
  if (text === null) return unknown();

  if (source.kind === "antigravity-installer") {
    return { version: parseAntigravityInstaller(text), packageName: null };
  }
  if (source.kind === "cursor-installer") {
    return { version: parseCursorInstaller(text), packageName: null };
  }

  const value = parseJson(text);
  if (source.kind === "npm-json") return npmResult(value);
  return piResult(value);
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

async function fetchText(url: string, deps: LatestDeps): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.httpTimeoutMs);
  try {
    const response = await deps.fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await readBody(response, deps.maxResponseBytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return null;
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
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
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
  if (typeof value.packageName !== "string" || !value.packageName.startsWith("@earendil-works/")) return unknown();
  return { version: value.version, packageName: value.packageName };
}

function resolveGrokVersion(item: AgentInventoryProbeItem, deps: LatestDeps): Promise<string | null> {
  if (item.discoveryStatus !== "available" || !item.resolvedBinary) return Promise.resolve(null);
  const binary = item.resolvedBinary;
  return new Promise((resolve) => {
    try {
      deps.execFile(binary, ["update", "--check"], {
        shell: false,
        timeout: deps.cliTimeoutMs,
        maxBuffer: deps.maxOutputBytes,
      }, (error: Error | null, stdout: string) => {
        if (error || typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > deps.maxOutputBytes) {
          resolve(null);
          return;
        }
        resolve(parseGrokUpdateCheck(stdout));
      });
    } catch {
      resolve(null);
    }
  });
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
