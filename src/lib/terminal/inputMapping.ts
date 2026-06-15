// Pure input-mapping logic: DOM keyboard/mouse events → semantic events for the
// server-side encoder, keybinding routing (app shortcut vs terminal input), and
// pixel→cell mapping. Kept free of DOM globals so it's unit-testable.

import type { Mods, MouseAction } from './gridProtocol';
import type { FontMetrics } from './renderer';

/** Minimal shape of a KeyboardEvent we read (so tests can pass plain objects). */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Special keys we send by name on keydown (everything else printable goes via
 *  the composition/`input` text path). Values match input_encoder key names. */
const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Insert',
  'Delete',
  'PageUp',
  'PageDown',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead']);

function mods(e: KeyLike): Mods {
  return { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
}

/** App-level shortcut (handled by the app, not sent to the PTY). Meta (⌘) combos
 *  are app shortcuts; Ctrl is NOT (so Ctrl+V reaches the agent for image paste). */
export function isAppShortcut(e: KeyLike): boolean {
  return e.metaKey;
}

/** Map a keydown to a semantic key event, or `null` when it should NOT be sent
 *  on keydown — either it's a bare modifier, an app shortcut, or a plain
 *  printable character (which flows through the `input`/composition text path). */
export function keyEventToSemantic(e: KeyLike): { key: string; mods: Mods } | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (isAppShortcut(e)) return null;
  if (NAMED_KEYS.has(e.key)) return { key: e.key, mods: mods(e) };
  // Single character: only send on keydown when a control modifier is held
  // (Ctrl/Alt). Plain text is left to the input/composition path.
  if ([...e.key].length === 1) {
    if (e.ctrlKey || e.altKey) return { key: e.key, mods: mods(e) };
    return null;
  }
  return null;
}

/** Browser MouseEvent.button (0 left, 1 middle, 2 right) → terminal button code. */
export function mouseButton(button: number): number {
  // X10/SGR: 0 left, 1 middle, 2 right.
  return button & 0b11;
}

/** Map pixel coordinates (relative to the canvas top-left) to a zero-based cell.
 *  Clamped to the grid. */
export function pixelToCell(
  x: number,
  y: number,
  metrics: FontMetrics,
  cols: number,
  rows: number,
): { col: number; row: number } {
  const col = Math.min(cols - 1, Math.max(0, Math.floor(x / metrics.cellWidth)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor(y / metrics.cellHeight)));
  return { col, row };
}

export type { MouseAction };
