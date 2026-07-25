import { describe, it, expect, beforeEach } from "vitest";
import { resolveAgentBinary, clearAgentBinaryCache, type AgentBinaryDeps } from "./agent-binary";

function deps(over: Partial<AgentBinaryDeps> = {}): AgentBinaryDeps {
  return {
    binaryName: "codex",
    reportedBin: null,
    env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
    homedir: () => "/Users/me",
    isExecutable: () => false,
    probe: () => true,
    loginShellPath: () => null,
    ...over,
  };
}

describe("resolveAgentBinary", () => {
  beforeEach(() => clearAgentBinaryCache());

  it("prefers the hook-reported path — it came from the agent's own env", () => {
    const d = deps({
      reportedBin: "/Users/me/.local/bin/codex",
      isExecutable: (p) => p === "/Users/me/.local/bin/codex",
    });
    expect(resolveAgentBinary(d)).toBe("/Users/me/.local/bin/codex");
  });

  it("falls back to the login-shell PATH when nothing was reported", () => {
    const d = deps({
      loginShellPath: () => "/Users/me/.local/bin:/usr/bin",
      isExecutable: (p) => p === "/Users/me/.local/bin/codex",
    });
    expect(resolveAgentBinary(d)).toBe("/Users/me/.local/bin/codex");
  });

  it("falls back to known install dirs when the login shell yields nothing", () => {
    const d = deps({ isExecutable: (p) => p === "/opt/homebrew/bin/codex" });
    expect(resolveAgentBinary(d)).toBe("/opt/homebrew/bin/codex");
  });

  it("rejects a candidate that fails the --version probe", () => {
    // Present and executable but not runnable (wrong arch, broken shim).
    const d = deps({
      reportedBin: "/Users/me/.local/bin/codex",
      isExecutable: () => true,
      probe: () => false,
    });
    expect(resolveAgentBinary(d)).toBeNull();
  });

  it("returns null when every layer misses", () => {
    expect(resolveAgentBinary(deps())).toBeNull();
  });

  it("caches per binary name so the probe runs once", () => {
    let probes = 0;
    const d = deps({
      reportedBin: "/Users/me/.local/bin/codex",
      isExecutable: () => true,
      probe: () => { probes++; return true; },
    });
    resolveAgentBinary(d);
    resolveAgentBinary(d);
    expect(probes).toBe(1);
  });
});
