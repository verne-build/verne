// Accessibility text projection: turn the grid into plain text rows for the
// offscreen screen-reader mirror. Pure; the host puts the result into the DOM
// mirror + aria-live region.

import type { Cell } from './gridProtocol';

/** Plain text for one row of cells (skips spacers, appends combining marks). */
export function rowToText(cells: Cell[]): string {
  let s = '';
  for (const cell of cells) {
    if (cell.width === 0) continue; // wide-char spacer
    s += String.fromCodePoint(cell.cp);
    if (cell.zw) for (const c of cell.zw) s += String.fromCodePoint(c);
  }
  return s.replace(/\s+$/u, ''); // trim trailing blanks
}

/** Plain text rows for the whole screen (for the readable mirror). */
export function gridToText(screen: Cell[][]): string[] {
  return screen.map(rowToText);
}

/** Coalesce buffered output lines into a single bounded polite announcement.
 *  Caps total length so an output flood can't jam the screen-reader queue. */
export function announcement(lines: string[], maxChars = 2000): string {
  const joined = lines.join('\n').replace(/\n{2,}/g, '\n').trim();
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}
