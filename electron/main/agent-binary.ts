// Resolve an agent CLI to an absolute, verified executable path.
//
// Why this exists: a packaged macOS GUI app's PATH does NOT include
// ~/.local/bin (where codex installs), so `spawn("codex")` works in `pnpm dev`
// — which inherits the launching terminal's PATH — and silently fails in a
// release build. Layers are ordered authoritative-first so a miss degrades
// instead of breaking.

import { join } from "node:path";

export interface AgentBinaryDeps {
  binaryName: string;
  /** Path the hook script resolved inside the AGENT's own environment
   *  (X-Verne-Agent-Bin). Authoritative when present — it cannot be wrong. */
  reportedBin?: string | null;
  env: { PATH?: string; SHELL?: string };
  homedir: () => string;
  isExecutable: (path: string) => boolean;
  /** `<path> --version` exited 0. Guards against a present-but-unrunnable file. */
  probe: (path: string) => boolean;
  /** `$SHELL -lc 'printf %s "$PATH"'` — the user's real interactive PATH. */
  loginShellPath: () => string | null;
}

const KNOWN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/** Resolved paths, keyed by binary name, for this app run. A null result is
 *  cached too: re-probing a missing binary on every prompt is wasteful. */
const cache = new Map<string, string | null>();

export function clearAgentBinaryCache(): void {
  cache.clear();
}

function candidates(deps: AgentBinaryDeps): string[] {
  const out: string[] = [];
  if (deps.reportedBin) out.push(deps.reportedBin);
  const dirsFrom = (path: string | null | undefined) =>
    (path ?? "").split(":").filter(Boolean);
  for (const dir of dirsFrom(deps.env.PATH)) out.push(join(dir, deps.binaryName));
  for (const dir of dirsFrom(deps.loginShellPath())) out.push(join(dir, deps.binaryName));
  out.push(join(deps.homedir(), ".local", "bin", deps.binaryName));
  for (const dir of KNOWN_DIRS) out.push(join(dir, deps.binaryName));
  return out;
}

export function resolveAgentBinary(deps: AgentBinaryDeps): string | null {
  const cached = cache.get(deps.binaryName);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  const seen = new Set<string>();
  for (const candidate of candidates(deps)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!deps.isExecutable(candidate)) continue;
    if (!deps.probe(candidate)) continue;
    found = candidate;
    break;
  }
  cache.set(deps.binaryName, found);
  return found;
}
