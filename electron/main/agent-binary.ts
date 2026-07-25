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

export function resolveAgentBinary(deps: AgentBinaryDeps): string | null {
  const cached = cache.get(deps.binaryName);
  if (cached !== undefined) return cached;

  const seen = new Set<string>();

  const check = (candidate: string): boolean => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return deps.isExecutable(candidate) && deps.probe(candidate);
  };

  const checkDirs = (path: string | null | undefined): string | null => {
    const dirs = (path ?? "").split(":").filter(Boolean);
    for (const dir of dirs) {
      const candidate = join(dir, deps.binaryName);
      if (check(candidate)) return candidate;
    }
    return null;
  };

  let found: string | null = null;

  // Layer 1: hook-reported path (most authoritative)
  if (deps.reportedBin) {
    if (check(deps.reportedBin)) {
      found = deps.reportedBin;
    }
  }

  // Layer 2: env.PATH
  if (!found) {
    found = checkDirs(deps.env.PATH);
  }

  // Layer 3: login shell PATH (called lazily only if earlier layers miss)
  if (!found) {
    found = checkDirs(deps.loginShellPath());
  }

  // Layer 4: ~/.local/bin
  if (!found) {
    const candidate = join(deps.homedir(), ".local", "bin", deps.binaryName);
    if (check(candidate)) {
      found = candidate;
    }
  }

  // Layer 5: known install dirs
  if (!found) {
    for (const dir of KNOWN_DIRS) {
      const candidate = join(dir, deps.binaryName);
      if (check(candidate)) {
        found = candidate;
        break;
      }
    }
  }

  // Only cache if we found something, or if reportedBin was supplied and failed
  // This prevents a miss without reportedBin from suppressing a later call with reportedBin
  if (found !== null || (deps.reportedBin !== undefined && deps.reportedBin !== null)) {
    cache.set(deps.binaryName, found);
  }

  return found;
}
