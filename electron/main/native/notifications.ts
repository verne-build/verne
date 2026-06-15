/**
 * Native macOS notifications on agent state transitions. Fired from the main
 * process (the window owner) so the focus check + click-to-focus are reliable.
 *
 * Edge-triggered on the `tab-updated` event (which arrives from BOTH detection
 * and the daemon hook receiver — see ipc-router forward). We notify on:
 *   - any → blocked        ("needs your input")
 *   - working → idle       ("finished")
 * Other idle transitions (SessionStart/Notification → idle) are noisy and don't
 * mean the agent stopped, so they're ignored.
 */

import { Notification, BrowserWindow, app } from "electron";
import { join } from "node:path";
import { currentSettings } from "./settings-cmds";
import type { AgentState } from "../../../src/types/shared";

// Custom notification sound. The OS Notification `sound` option can't reliably
// play an arbitrary bundled file (and differs per platform), so we set
// `silent: true` and play resources/notification.wav in the renderer via the
// verne-asset:// scheme — Chromium decodes wav on every platform, so this is
// cross-platform. Safe because handleTabUpdate only runs while the window is
// alive (the makeForward guard bails on a destroyed window).
function notificationWavPath(): string {
  const dir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
  return join(dir, "notification.wav");
}

function playNotificationSound(win: BrowserWindow): void {
  try {
    if (currentSettings().notificationsSound === false) return;
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send("daemon-event", "play-notification-sound", { path: notificationWavPath() });
  } catch (e) {
    console.error("[notifications] playNotificationSound:", e);
  }
}

interface TabUpdate {
  tabId?: string;
  agentType?: string;
  agentState?: AgentState;
}

// Last state we saw per tab — drives edge detection so repeated same-state
// events (blocked redraws, idle pings) don't refire.
const lastState = new Map<string, AgentState>();

// One entry per detection manifest — keep identical to src/lib/agentNotifications.ts.
const AGENT_LABEL: Record<string, string> = {
  amp: "Amp",
  antigravity: "Antigravity",
  claude: "Claude",
  cline: "Cline",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  droid: "Droid",
  gemini: "Gemini",
  grok: "Grok",
  hermes: "Hermes",
  kilo: "Kilo",
  kimi: "Kimi",
  kiro: "Kiro",
  opencode: "OpenCode",
  pi: "Pi",
  qodercli: "Qoder",
};

function notifyKind(prev: AgentState | undefined, cur: AgentState): "blocked" | "finished" | null {
  if (cur === "blocked" && prev !== "blocked") return "blocked";
  if (cur === "idle" && prev === "working") return "finished";
  return null;
}

export function handleTabUpdate(payload: TabUpdate, win: BrowserWindow): void {
  const { tabId, agentType, agentState } = payload;
  if (!tabId || !agentState) return;

  const prev = lastState.get(tabId);
  lastState.set(tabId, agentState);

  const kind = notifyKind(prev, agentState);
  if (!kind) return;
  if (!agentType) return; // only agent tabs notify
  if (!Notification.isSupported()) return;

  // Focus gate: when on (default), suppress while the window is focused.
  const gate = currentSettings().notificationsFocusGate !== false;
  if (gate && !win.isDestroyed() && win.isFocused()) return;

  const agent = AGENT_LABEL[agentType] ?? agentType;
  const title = kind === "blocked" ? `${agent} needs your input` : `${agent} finished`;

  const n = new Notification({ title, silent: true });
  n.on("click", () => {
    try {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send("daemon-event", "focus-tab", { tabId });
    } catch (e) {
      console.error("[notifications] click handler:", e);
    }
  });
  n.show();
  playNotificationSound(win);
}

/**
 * Debug: fire a notification immediately, bypassing the focus gate + edge
 * detection. Isolates the OS notification path (system permission / DND /
 * isSupported) from the agent-state trigger logic. Wired to the hidden ⌘⌃⇧N
 * shortcut. Logs diagnostics so a silent failure is attributable.
 */
export function showTestNotification(win: BrowserWindow): { supported: boolean; focused: boolean } {
  const supported = Notification.isSupported();
  const focused = !win.isDestroyed() && win.isFocused();
  console.log(`[notifications] test: isSupported=${supported} windowFocused=${focused}`);
  if (!supported) return { supported, focused };

  const n = new Notification({
    title: "Verne test notification",
    body: "OS notifications are working.",
    silent: true,
  });
  n.on("show", () => console.log("[notifications] test: shown"));
  n.on("failed", (_e, err) => console.error("[notifications] test: failed", err));
  n.on("click", () => {
    try {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (e) {
      console.error("[notifications] test click:", e);
    }
  });
  n.show();
  playNotificationSound(win);
  return { supported, focused };
}

/** Drop a closed tab's tracked state (called on tab close to avoid leaks). */
export function forgetTab(tabId: string): void {
  lastState.delete(tabId);
}
