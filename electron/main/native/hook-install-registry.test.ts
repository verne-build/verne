import { describe, expect, it } from "vitest";
import { HOOK_INSTALLERS } from "./hook-install-registry";

const EXPECTED_INSTALLERS = [
  "antigravity",
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
];

describe("hook installer registry", () => {
  it("has each supported installer", () => {
    for (const key of EXPECTED_INSTALLERS) {
      expect(HOOK_INSTALLERS[key], `missing installer for ${key}`).toBeTypeOf("function");
    }
  });

  it("does not install Copilot hooks", () => {
    expect(Object.keys(HOOK_INSTALLERS).sort()).toEqual([...EXPECTED_INSTALLERS].sort());
  });
});
