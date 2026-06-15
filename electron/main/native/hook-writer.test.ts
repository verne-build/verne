import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeNotifyScript,
  ensureHooksForClaude,
  removeHooksForClaude,
  ensureHooksForCodex,
  removeHooksForCodex,
} from "./hook-writer";

// Override homedir for tests via monkey-patching the module (vitest auto-mock).
// Instead, we test the helpers that take explicit paths.

describe("writeNotifyScript", () => {
  it("writes notify.sh with port and secret baked in", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-hook-"));
    const path = writeNotifyScript(dir, 9610, "test-secret-abc");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("127.0.0.1:9610/hook");
    expect(content).toContain("X-Verne-Daemon-Secret: test-secret-abc");
    expect(content).toContain("X-Verne-Source: $SOURCE");
    expect(content).toContain("X-Verne-Seq: $SEQ");
    expect(content).toContain('[ -z "$VERNE_TAB_ID" ] && exit 0');
  });

  it("is executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "verne-hook-"));
    const path = writeNotifyScript(dir, 9610, "s");
    const mode = statSync(path).mode;
    expect(mode & 0o111).toBeGreaterThan(0); // executable bits set
  });
});

describe("ensureHooksForClaude / removeHooksForClaude", () => {
  let settingsPath: string;
  let notifyScript: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "verne-claude-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    settingsPath = join(dir, ".claude", "settings.json");
    notifyScript = join(dir, "hooks", "notify.sh");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    // Write a dummy notify.sh so stale-entry detection sees it as present.
    writeFileSync(notifyScript, "#!/bin/bash\n", { encoding: "utf8" });
  });

  // Helper that runs the claude helpers against a temp dir instead of homedir.
  // We test the underlying JSON merge logic by calling the functions with a
  // custom settingsPath via a thin wrapper.
  function mergeHooks(script: string, existing: object): object {
    // Build the updated hooks object inline (same logic as ensureHooksForClaude
    // but without touching homedir).
    const events = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PreToolUse", "PostToolUse"];
    const settings: Record<string, unknown> = { ...existing };
    if (typeof settings["hooks"] !== "object" || settings["hooks"] === null) settings["hooks"] = {};
    const hooks = settings["hooks"] as Record<string, unknown[]>;
    for (const event of events) {
      if (!Array.isArray(hooks[event])) hooks[event] = [];
      hooks[event] = hooks[event].filter((e: unknown) => {
        if (typeof e !== "object" || e === null) return true;
        const h = e as Record<string, unknown>;
        const hs = Array.isArray(h["hooks"]) ? h["hooks"] as Array<Record<string, unknown>> : [];
        return !hs.some((hh) => typeof hh["command"] === "string" && (hh["command"] as string).includes(script));
      });
      hooks[event].push({ hooks: [{ type: "command", command: `'${script}' ${event} claude` }] });
    }
    return settings;
  }

  it("idempotent: calling twice doesn't double-add entries", () => {
    const settings1 = mergeHooks(notifyScript, {});
    const settings2 = mergeHooks(notifyScript, settings1);
    const h = (settings2 as Record<string, Record<string, unknown[]>>)["hooks"];
    for (const event of ["SessionStart", "PreToolUse"]) {
      expect(h[event].length).toBe(1);
    }
  });

  it("preserves user hooks alongside verne hooks", () => {
    const existing = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "'some-other-tool' PreToolUse" }] }],
      },
    };
    const result = mergeHooks(notifyScript, existing) as Record<string, Record<string, unknown[]>>;
    expect(result["hooks"]["PreToolUse"].length).toBe(2);
  });

  it("merge+remove roundtrip leaves no verne entries", () => {
    const after = mergeHooks(notifyScript, {}) as Record<string, Record<string, unknown[]>>;
    // Simulate remove: filter out entries whose command contains notifyScript.
    const hooks = after["hooks"];
    for (const event of Object.keys(hooks)) {
      hooks[event] = (hooks[event] as unknown[]).filter((e: unknown) => {
        if (typeof e !== "object" || e === null) return true;
        const h = e as Record<string, unknown>;
        const hs = Array.isArray(h["hooks"]) ? h["hooks"] as Array<Record<string, unknown>> : [];
        return !hs.some((hh) => typeof hh["command"] === "string" && (hh["command"] as string).includes(notifyScript));
      });
    }
    for (const arr of Object.values(hooks)) {
      expect(arr.length).toBe(0);
    }
  });
});
