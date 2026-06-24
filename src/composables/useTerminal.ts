// Terminal session transport registry + app-wide layout/font helpers.
//
// The terminal is rendered by GridTerminal.vue (the canvas/WebGL grid renderer);
// each mounted instance opens its own `?proto=grid` GridSession. This module
// keeps a registry of the live (mounted) sessions keyed by PTY session id so
// app-level code can inject text (dictation, add-to-agent, diff-review) and
// reconnect after sleep without holding a component ref.
//
// Note: background (unmounted) tabs have no open socket, so injection targets
// the foreground/mounted session — the same effective reach the old xterm cache
// had once it stopped being populated for live tabs.

import type { GridSession } from "@/lib/terminal/GridSession";
import { useSettings } from "./useSettings";

interface GridEntry {
  session: GridSession;
  renderKind: string; // 'webgl2' | 'canvas2d'
}

const registry = new Map<string, GridEntry>();

/** Called by GridTerminal on mount (after `session.connect()`). */
export function registerGridSession(
  sessionId: string,
  session: GridSession,
  renderKind: string,
): void {
  registry.set(sessionId, { session, renderKind });
}

/** Called by GridTerminal on unmount. */
export function unregisterGridSession(sessionId: string): void {
  registry.delete(sessionId);
}

/** Send raw text to a session's PTY by id, regardless of which component owns
 *  it. Returns false if no live (mounted) grid session is registered. The send
 *  queues if the socket is still connecting and flushes on open. */
export function sendTextToSession(sessionId: string, text: string): boolean {
  if (!sessionId || !text) return false;
  const entry = registry.get(sessionId);
  if (!entry) return false;
  entry.session.sendText(text);
  return true;
}

/** Resolve once a session's agent TUI has enabled bracketed-paste mode (DECSET
 *  2004) — the agent's own signal that its input line is up and ready to accept
 *  a paste. Lets callers gate a paste on real readiness instead of a fixed sleep.
 *  Returns false if it stays unready (or no live session is registered) past the
 *  timeout. The mode bit rides the grid frames into `store.modes.bracketedPaste`. */
export async function waitForPasteReady(sessionId: string, timeoutMs = 12000): Promise<boolean> {
  if (!sessionId) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (registry.get(sessionId)?.session.store.modes.bracketedPaste) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Reopen any dropped sockets (e.g. after system sleep). */
export function reconnectAllTerminals(): void {
  for (const entry of registry.values()) entry.session.reconnectIfClosed();
}

// ---- font preload -----------------------------------------------------------

const { settings } = useSettings();

function primaryFamily(stack: string | undefined): string {
  const first = (stack ?? "").split(",")[0]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "") || "monospace";
}

/** Preload the configured terminal font (normal + bold) so the grid renderer
 *  measures correct glyph metrics on first paint. */
export async function preloadConfiguredTerminalFont(): Promise<void> {
  if (!("fonts" in document)) return;
  const px = `${settings.value.terminalFontSize ?? 14}px`;
  const family = primaryFamily(settings.value.terminalFontFamily);
  try {
    await Promise.all([
      document.fonts.load(`${px} "${family}"`),
      document.fonts.load(`bold ${px} "${family}"`),
    ]);
  } catch {
    // best-effort; the renderer re-measures when the font-settings watch fires
  }
  await new Promise((r) => requestAnimationFrame(r));
}

// ---- layout hooks ------------------------------------------------------------
// The grid renderer self-fits via each GridTerminal's ResizeObserver (with its
// own resize coalescing), so these app-level hooks are now no-ops kept for their
// existing call sites (App.vue, SplitLayout.vue).

export function flushTerminalLayouts(): void {}
export function setSplitterDragging(_active?: boolean): void {}

// ---- debug metrics (ResourceMonitor) ----------------------------------------

let mountedViewCount = 0;

export function incrementMountedTerminalViewCount(): void {
  mountedViewCount += 1;
}

export function decrementMountedTerminalViewCount(): void {
  mountedViewCount = Math.max(0, mountedViewCount - 1);
}

export function getMountedTerminalViewCount(): number {
  return mountedViewCount;
}

export function getCachedTerminalCount(): number {
  return registry.size;
}

export function getAttachedTerminalCount(): number {
  return registry.size;
}

export function getTerminalResizeObserverCount(): number {
  return registry.size;
}

export function getWebGLContextCount(): number {
  let n = 0;
  for (const e of registry.values()) if (e.renderKind === "webgl2") n += 1;
  return n;
}
