import { describe, expect, it } from "vitest";
import { HOOK_INSTALLERS } from "./hook-install-registry";

// Mirror of the daemon registry's installable set (agent_registry.rs
// integration_set_is_exactly_the_installable_agents). These two lists are the
// contract between daemon and main; they MUST match.
const DAEMON_INTEGRATIONS = [
  "antigravity",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "opencode",
  "pi",
];

describe("hook installer registry", () => {
  it("has an installer for every daemon integration", () => {
    for (const key of DAEMON_INTEGRATIONS) {
      expect(HOOK_INSTALLERS[key], `missing installer for ${key}`).toBeTypeOf("function");
    }
  });

  it("has no installer without a daemon integration", () => {
    for (const key of Object.keys(HOOK_INSTALLERS)) {
      expect(DAEMON_INTEGRATIONS, `orphan installer ${key}`).toContain(key);
    }
  });
});
