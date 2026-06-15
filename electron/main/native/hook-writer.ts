/**
 * Hook-config writer. Writes notify.sh and installs/removes hooks in each
 * agent's config file. Owned by Electron now that the hook receiver lives in
 * the daemon.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Write notify.sh into <internalDataDir>/hooks/notify.sh. Returns the script path. */
export function writeNotifyScript(internalDataDir: string, port: number, secret: string): string {
  const dir = join(internalDataDir, "hooks");
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "notify.sh");
  const content = `#!/bin/bash
# Verne agent lifecycle hook — forwards full stdin payload to local hook server.
# No VERNE_TAB_ID = not a verne-spawned agent. Routing without this env var is
# the only way external sessions bleed into verne tabs, so ignore them.
[ -z "$VERNE_TAB_ID" ] && exit 0
STDIN_DATA=$(cat 2>/dev/null)

# Agent type comes from the hook entry's 2nd arg (claude/codex/copilot — baked
# in per ~/.claude or ~/.codex config file). Env var is the legacy fallback
# for auto-launched providers; manually-launched agents inherit only
# VERNE_TAB_ID and need the positional arg.
AGENT_TYPE="\${2:-$VERNE_AGENT_TYPE}"
SOURCE="hook:$AGENT_TYPE"
# Microsecond wall-clock sequence is shared by independent hook processes.
SEQ=$(perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000000' 2>/dev/null)
[ -z "$SEQ" ] && SEQ=$(date +%s)

curl -s -X POST "http://127.0.0.1:${port}/hook" \\
  -H "Content-Type: application/json" \\
  -H "X-Verne-Daemon-Secret: ${secret}" \\
  -H "X-Verne-Event: $1" \\
  -H "X-Verne-Agent-Id: $VERNE_AGENT_ID" \\
  -H "X-Verne-Agent-Type: $AGENT_TYPE" \\
  -H "X-Verne-Tab-Id: $VERNE_TAB_ID" \\
  -H "X-Verne-Source: $SOURCE" \\
  -H "X-Verne-Seq: $SEQ" \\
  --data-binary "$STDIN_DATA" \\
  --max-time 2 \\
  > /dev/null 2>&1 &
`;
  writeFileSync(scriptPath, content, { encoding: "utf8" });
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function verneHookEntry(script: string, event: string, agentType: string): object {
  return {
    hooks: [{ type: "command", command: `'${script}' ${event} ${agentType}` }],
  };
}

function isVerneEntry(entry: unknown, marker: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  const hooks = e["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    if (typeof h !== "object" || h === null) return false;
    const cmd = (h as Record<string, unknown>)["command"];
    return typeof cmd === "string" && cmd.includes(marker);
  });
}

function verneScriptPath(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const hooks = (entry as Record<string, unknown>)["hooks"];
  if (!Array.isArray(hooks)) return null;
  for (const h of hooks) {
    if (typeof h !== "object" || h === null) continue;
    const cmd = (h as Record<string, unknown>)["command"];
    if (typeof cmd !== "string" || !cmd.startsWith("'")) continue;
    const rest = cmd.slice(1);
    const close = rest.indexOf("'");
    if (close === -1) continue;
    const path = rest.slice(0, close);
    if (path.endsWith("/notify.sh")) return path;
  }
  return null;
}

function isStaleVerneEntry(entry: unknown): boolean {
  const p = verneScriptPath(entry);
  if (!p) return false;
  return !existsSync(p);
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8" });
  renameSync(tmp, path);
}

// ── Claude ────────────────────────────────────────────────────────────────────

// Notification is Claude's real "needs attention" hook (permission requests +
// 60s idle-prompt — both self-heal a stuck "working"); SessionEnd → idle on
// exit. PermissionRequest is not a Claude event but kept for forward-compat.
const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
] as const;

/** Merge Verne hooks into ~/.claude/settings.json. Idempotent. */
export function ensureHooksForClaude(notifyScript: string): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = readJson(settingsPath);

  if (typeof settings["hooks"] !== "object" || settings["hooks"] === null || Array.isArray(settings["hooks"])) {
    settings["hooks"] = {};
  }
  const hooks = settings["hooks"] as Record<string, unknown>;

  for (const event of CLAUDE_EVENTS) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const entries = hooks[event] as unknown[];
    // Remove this-instance entries + stale entries
    const kept = entries.filter((e) => !isVerneEntry(e, notifyScript) && !isStaleVerneEntry(e));
    kept.push(verneHookEntry(notifyScript, event, "claude"));
    hooks[event] = kept;
  }

  writeJson(settingsPath, settings);
}

/** Remove this instance's hook entries from ~/.claude/settings.json. */
export function removeHooksForClaude(notifyScript: string): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = readJson(settingsPath);
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return;
  const h = hooks as Record<string, unknown>;
  for (const event of Object.keys(h)) {
    if (!Array.isArray(h[event])) continue;
    h[event] = (h[event] as unknown[]).filter((e) => !isVerneEntry(e, notifyScript));
    if ((h[event] as unknown[]).length === 0) delete h[event];
  }
  if (Object.keys(h).length === 0) delete settings["hooks"];
  writeJson(settingsPath, settings);
}

// ── Codex ─────────────────────────────────────────────────────────────────────

const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
] as const;

/** Merge Verne hooks into ~/.codex/hooks.json. Idempotent. */
export function ensureHooksForCodex(notifyScript: string): void {
  const hooksPath = join(homedir(), ".codex", "hooks.json");
  const settings = readJson(hooksPath);
  if (typeof settings["hooks"] !== "object" || settings["hooks"] === null || Array.isArray(settings["hooks"])) {
    settings["hooks"] = {};
  }
  const hooks = settings["hooks"] as Record<string, unknown>;
  for (const event of CODEX_EVENTS) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const entries = hooks[event] as unknown[];
    const kept = entries.filter((e) => !isVerneEntry(e, notifyScript) && !isStaleVerneEntry(e));
    kept.push(verneHookEntry(notifyScript, event, "codex"));
    hooks[event] = kept;
  }
  writeJson(hooksPath, settings);
}

/** Remove this instance's hook entries from ~/.codex/hooks.json. */
export function removeHooksForCodex(notifyScript: string): void {
  const hooksPath = join(homedir(), ".codex", "hooks.json");
  if (!existsSync(hooksPath)) return;
  const settings = readJson(hooksPath);
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return;
  const h = hooks as Record<string, unknown>;
  for (const event of Object.keys(h)) {
    if (!Array.isArray(h[event])) continue;
    h[event] = (h[event] as unknown[]).filter((e) => !isVerneEntry(e, notifyScript));
    if ((h[event] as unknown[]).length === 0) delete h[event];
  }
  if (Object.keys(h).length === 0) delete settings["hooks"];
  writeJson(hooksPath, settings);
}

// ── Copilot ───────────────────────────────────────────────────────────────────

/** Write full ~/.copilot/hooks/verne.json. Idempotent. */
export function ensureHooksForCopilot(notifyScript: string): void {
  const hooksDir = join(homedir(), ".copilot", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const config = {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", bash: `'${notifyScript}' sessionStart copilot`, timeoutSec: 5 }],
      userPromptSubmitted: [{ type: "command", bash: `'${notifyScript}' userPromptSubmitted copilot`, timeoutSec: 5 }],
      preToolUse: [{ type: "command", bash: `'${notifyScript}' preToolUse copilot`, timeoutSec: 5 }],
      postToolUse: [{ type: "command", bash: `'${notifyScript}' postToolUse copilot`, timeoutSec: 5 }],
      sessionEnd: [{ type: "command", bash: `'${notifyScript}' sessionEnd copilot`, timeoutSec: 5 }],
    },
  };
  writeJson(join(hooksDir, "verne.json"), config);
}

/** Remove ~/.copilot/hooks/verne.json if present. */
export function removeHooksForCopilot(_notifyScript: string): void {
  const path = join(homedir(), ".copilot", "hooks", "verne.json");
  if (existsSync(path)) rmSync(path);
}

// ── Antigravity CLI (`agy`) ───────────────────────────────────────────────────
// agy reads named JSON hooks from ~/.gemini/config/hooks.json — NOT the `hooks`
// block in ~/.gemini/settings.json (which it ignores). Verified against the agy
// binary ("loaded N named hooks from M hooks.json file(s)"). Schema: a top-level
// object keyed by a hook-GROUP name; each group maps an event to an array of {type,command}
// (lifecycle) or {matcher, hooks:[{type,command}]} (tool events). Events:
// PreInvocation / PostInvocation / PreToolUse / PostToolUse / Stop — mapped to
// state in the daemon's hook_to_state.

function agyCmd(script: string, event: string): object {
  return { type: "command", command: `'${script}' ${event} antigravity` };
}
function agyToolGroup(script: string, event: string): object {
  return { matcher: "*", hooks: [agyCmd(script, event)] };
}

/** Install Verne's hook group into ~/.gemini/config/hooks.json (preserving other
 *  groups). Also strips the old, ineffective entries we used to write to
 *  ~/.gemini/settings.json `hooks` (agy ignores those). Idempotent. */
export function ensureHooksForAntigravity(notifyScript: string): void {
  const hooksPath = join(homedir(), ".gemini", "config", "hooks.json");
  const groups = readJson(hooksPath);
  groups["verne"] = {
    PreInvocation: [agyCmd(notifyScript, "PreInvocation")], // generating → working
    PostInvocation: [agyCmd(notifyScript, "PostInvocation")], // turn step done → working
    Stop: [agyCmd(notifyScript, "Stop")], // fully done → idle
    // agy surfaces a tool-confirmation right after PreToolUse and waits for the
    // user, so it's a BLOCKED state, not working — emit PermissionRequest (which
    // maps to blocked) instead of PreToolUse. PostToolUse means the tool ran → working.
    PreToolUse: [agyToolGroup(notifyScript, "PermissionRequest")],
    PostToolUse: [agyToolGroup(notifyScript, "PostToolUse")],
  };
  writeJson(hooksPath, groups);
  clearStaleAntigravitySettingsHooks(notifyScript);
}

/** Remove Verne's hook group from ~/.gemini/config/hooks.json. */
export function removeHooksForAntigravity(notifyScript: string): void {
  const hooksPath = join(homedir(), ".gemini", "config", "hooks.json");
  if (existsSync(hooksPath)) {
    const groups = readJson(hooksPath);
    if ("verne" in groups) {
      delete groups["verne"];
      writeJson(hooksPath, groups);
    }
  }
  clearStaleAntigravitySettingsHooks(notifyScript);
}

/** One-time cleanup of the (ineffective) Verne hook entries we previously wrote
 *  to ~/.gemini/settings.json `hooks`. Only rewrites the file if it changed. */
function clearStaleAntigravitySettingsHooks(notifyScript: string): void {
  const settingsPath = join(homedir(), ".gemini", "settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = readJson(settingsPath);
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return;
  const h = hooks as Record<string, unknown>;
  let changed = false;
  for (const event of Object.keys(h)) {
    if (!Array.isArray(h[event])) continue;
    const arr = h[event] as unknown[];
    const kept = arr.filter((e) => !isVerneEntry(e, notifyScript));
    if (kept.length !== arr.length) changed = true;
    if (kept.length === 0) delete h[event];
    else h[event] = kept;
  }
  if (!changed) return;
  if (Object.keys(h).length === 0) delete settings["hooks"];
  writeJson(settingsPath, settings);
}

// ── Cursor Agent CLI ────────────────────────────────────────────────────────
// ~/.cursor/hooks.json `{version:1, hooks:{event:[{command}]}}`. Entry shape is a
// FLAT {command} (not the {hooks:[...]} wrapper), so it needs its own
// detection. The hook is run as a process that receives JSON on stdin — notify.sh
// reads stdin and forwards it. `preToolUse`/`postToolUse`/`stop`/`sessionStart`
// reuse the daemon's existing state mapping; `beforeSubmitPrompt` is added there.

// The terminal CLI (`cursor-agent`) fires only beforeShellExecution /
// afterShellExecution today; the richer events fire in IDE/cloud contexts.
// Install both sets so whichever surface runs gets coverage.
const CURSOR_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "beforeShellExecution",
  "afterShellExecution",
  "stop",
] as const;

function isCursorVerneEntry(entry: unknown, marker: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const cmd = (entry as Record<string, unknown>)["command"];
  return typeof cmd === "string" && cmd.includes(marker);
}

/** Merge Verne hooks into ~/.cursor/hooks.json. Idempotent. */
export function ensureHooksForCursor(notifyScript: string): void {
  const hooksPath = join(homedir(), ".cursor", "hooks.json");
  const settings = readJson(hooksPath);
  if (typeof settings["version"] !== "number") settings["version"] = 1;
  if (typeof settings["hooks"] !== "object" || settings["hooks"] === null || Array.isArray(settings["hooks"])) {
    settings["hooks"] = {};
  }
  const hooks = settings["hooks"] as Record<string, unknown>;
  for (const event of CURSOR_EVENTS) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const kept = (hooks[event] as unknown[]).filter((e) => !isCursorVerneEntry(e, notifyScript));
    kept.push({ command: `'${notifyScript}' ${event} cursor` });
    hooks[event] = kept;
  }
  writeJson(hooksPath, settings);
}

/** Remove this instance's hook entries from ~/.cursor/hooks.json. */
export function removeHooksForCursor(notifyScript: string): void {
  const hooksPath = join(homedir(), ".cursor", "hooks.json");
  if (!existsSync(hooksPath)) return;
  const settings = readJson(hooksPath);
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return;
  const h = hooks as Record<string, unknown>;
  for (const event of Object.keys(h)) {
    if (!Array.isArray(h[event])) continue;
    h[event] = (h[event] as unknown[]).filter((e) => !isCursorVerneEntry(e, notifyScript));
    if ((h[event] as unknown[]).length === 0) delete h[event];
  }
  if (Object.keys(h).length === 0) delete settings["hooks"];
  writeJson(hooksPath, settings);
}
