// A no-op GridTransport for a frozen, read-only archived snapshot. It wraps a
// pre-seeded GridStore and opens NO socket: every input/fetch/search/resize call
// is a no-op, so a TerminalController(readOnly) can drive selection/scroll/copy
// against captured scrollback without any live PTY behind it.

import type { GridStore } from './GridStore';
import type { GridTransport } from './TerminalController';
import type { Mods, MouseAction, SearchResultFrame } from './gridProtocol';

export class StaticGridTransport implements GridTransport {
  readonly store: GridStore;
  /** Never invoked (no frames arrive), but kept for interface parity. */
  onUpdate?: () => void;
  onSearchResult?: (r: SearchResultFrame) => void;

  constructor(store: GridStore) {
    this.store = store;
  }

  // ---- input: swallowed (archived sessions accept none) ----
  sendKey(_key: string, _mods?: Mods): void {}
  sendText(_text: string): void {}
  sendPaste(_text: string): void {}
  sendMouse(
    _action: MouseAction,
    _button: number,
    _col: number,
    _row: number,
    _mods?: Mods,
  ): void {}

  // ---- history: full scrollback is pre-seeded, so nothing to fetch/cancel ----
  fetchHistory(_from: number, _to: number): number {
    return 0;
  }
  cancelHistory(_reqId: number): void {}
  cancelAllFetches(): void {}

  // ---- search / resize: no live backend to answer ----
  search(_query: string, _opts?: { limit?: number; caseSensitive?: boolean }): number {
    return 0;
  }
  resize(_cols: number, _rows: number): void {}

  dispose(): void {}
}
