// Client-side decoder for the grid-streaming terminal protocol. Mirrors the
// byte layout produced by daemon `services/grid_protocol.rs`. See that file for
// the authoritative format; the two MUST stay in sync.

/** Cell attribute bits (matches grid_protocol::flags). */
export const FLAG = {
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  INVERSE: 1 << 4,
  STRIKEOUT: 1 << 5,
  HIDDEN: 1 << 6,
  WIDE: 1 << 7,
  ZEROWIDTH: 1 << 8,
  UNDERCURL: 1 << 9,
  DOUBLE_UNDERLINE: 1 << 10,
  DOTTED_UNDERLINE: 1 << 11,
  DASHED_UNDERLINE: 1 << 12,
  UNDERLINE_COLOR: 1 << 13,
  /** Cell is part of an OSC-8 hyperlink (URI tail follows). */
  HYPERLINK: 1 << 14,
} as const;

/** Any underline style bit set. */
export const ANY_UNDERLINE =
  FLAG.UNDERLINE |
  FLAG.UNDERCURL |
  FLAG.DOUBLE_UNDERLINE |
  FLAG.DOTTED_UNDERLINE |
  FLAG.DASHED_UNDERLINE;

// Colors are packed into a number for compactness:
//   DEFAULT_COLOR (0) | indexed: (1<<24)|i | rgb: (2<<24)|(r<<16)|(g<<8)|b
export const DEFAULT_COLOR = 0;
export const indexedColor = (i: number) => (1 << 24) | (i & 0xff);
export const rgbColor = (r: number, g: number, b: number) =>
  (2 << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
export const colorKind = (c: number) => (c === 0 ? 0 : c >>> 24);

export interface Cell {
  /** Unicode code point. */
  cp: number;
  fg: number;
  bg: number;
  flags: number;
  /** Display width: 1 or 2. */
  width: number;
  /** Combining marks (code points); usually empty. */
  zw?: number[];
  /** Explicit underline color (packed); undefined → use the foreground. */
  ulColor?: number;
  /** OSC-8 hyperlink target URI; undefined for the common case. */
  link?: string;
}

export interface RowRun {
  line: number;
  startCol: number;
  cells: Cell[];
  /** Row soft-wraps into the next (copy joins without newline). */
  wrapped: boolean;
}

export type CursorShape = 'block' | 'beam' | 'underline' | 'hollow' | 'hidden';

export interface SyncFrame {
  type: 'sync';
  rev: number;
  cols: number;
  rows: number;
  cursor: [number, number];
  altScreen: boolean;
  modes: WireModes;
  totalLines: number;
  /** Rows evicted off the top of scrollback so far. A row's stable absolute id
   *  = base + its visual index; keys the history cache + frozen-scroll anchor so
   *  streaming eviction doesn't corrupt scrollback. Optional in tests / from an
   *  older daemon; decoder + store default it to 0. */
  base?: number;
  /** Optional in tests; the decoder always supplies it (defaults to 'block'). */
  cursorShape?: CursorShape;
  cursorBlink?: boolean;
  runs: RowRun[];
}

export interface DeltaFrame {
  type: 'delta';
  rev: number;
  cursor: [number, number];
  modes: WireModes;
  totalLines: number;
  /** See SyncFrame.base. Lets a frozen client re-anchor across eviction. */
  base?: number;
  cursorShape?: CursorShape;
  cursorBlink?: boolean;
  runs: RowRun[];
}

export interface HistoryFrame {
  type: 'history';
  reqId: number;
  from: number;
  to: number;
  /** Server eviction count when these rows were read; row i's stable id =
   *  base + from + i. Optional from an older daemon; store defaults it to 0. */
  base?: number;
  runs: RowRun[];
}

export interface WireModes {
  mouseReporting: boolean;
  /** 1002: report motion while a button is held (drag). */
  mouseDrag?: boolean;
  /** 1003: report all motion (even with no button held). */
  mouseMotion?: boolean;
  altScreen: boolean;
  appCursor: boolean;
  bracketedPaste: boolean;
}

export interface SearchMatch {
  line: number;
  col: number;
  len: number;
}

export interface SearchResultFrame {
  type: 'searchResult';
  reqId: number;
  matches: SearchMatch[];
  done: boolean;
}

export type DecodedFrame = SyncFrame | DeltaFrame | HistoryFrame | SearchResultFrame;

function decodeColor(dv: DataView, off: number): [number, number] {
  const tag = dv.getUint8(off);
  off += 1;
  if (tag === 0) return [DEFAULT_COLOR, off];
  if (tag === 1) {
    const i = dv.getUint8(off);
    return [indexedColor(i), off + 1];
  }
  // tag === 2 (rgb)
  const r = dv.getUint8(off);
  const g = dv.getUint8(off + 1);
  const b = dv.getUint8(off + 2);
  return [rgbColor(r, g, b), off + 3];
}

const utf8 = new TextDecoder();

/** `intern` dedups repeated URI strings within a frame so a run of hyperlinked
 *  cells shares one JS string (cheap equality + less memory). */
function decodeCell(dv: DataView, off: number, intern: Map<string, string>): [Cell, number] {
  const cp = dv.getUint32(off, true);
  off += 4;
  let fg: number;
  let bg: number;
  [fg, off] = decodeColor(dv, off);
  [bg, off] = decodeColor(dv, off);
  const flags = dv.getUint16(off, true);
  off += 2;
  const width = dv.getUint8(off);
  off += 1;
  let zw: number[] | undefined;
  if (flags & FLAG.ZEROWIDTH) {
    const count = dv.getUint8(off);
    off += 1;
    zw = [];
    for (let i = 0; i < count; i++) {
      zw.push(dv.getUint32(off, true));
      off += 4;
    }
  }
  let ulColor: number | undefined;
  if (flags & FLAG.UNDERLINE_COLOR) {
    [ulColor, off] = decodeColor(dv, off);
  }
  let link: string | undefined;
  if (flags & FLAG.HYPERLINK) {
    const len = dv.getUint16(off, true);
    off += 2;
    const raw = utf8.decode(new Uint8Array(dv.buffer, dv.byteOffset + off, len));
    off += len;
    link = intern.get(raw) ?? (intern.set(raw, raw), raw);
  }
  return [{ cp, fg, bg, flags, width, zw, ulColor, link }, off];
}

function decodeRuns(payload: Uint8Array): RowRun[] {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = 0;
  const count = dv.getUint16(off, true);
  off += 2;
  const intern = new Map<string, string>();
  const runs: RowRun[] = [];
  for (let i = 0; i < count; i++) {
    const line = dv.getUint16(off, true);
    off += 2;
    const startCol = dv.getUint16(off, true);
    off += 2;
    const cellCount = dv.getUint16(off, true);
    off += 2;
    const wrapped = dv.getUint8(off) !== 0; off += 1; // [u8 wrapped] — wire contract
    const cells: Cell[] = [];
    for (let j = 0; j < cellCount; j++) {
      let cell: Cell;
      [cell, off] = decodeCell(dv, off, intern);
      cells.push(cell);
    }
    runs.push({ line, startCol, cells, wrapped });
  }
  return runs;
}

/** Decode one daemon → client frame: `\0` + u32-BE header len + JSON + payload. */
export function decodeFrame(buf: Uint8Array): DecodedFrame {
  if (buf[0] !== 0) {
    throw new Error('grid frame: missing 0 marker byte');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = dv.getUint32(1, false); // big-endian
  const headerStart = 5;
  const headerStr = new TextDecoder().decode(buf.subarray(headerStart, headerStart + headerLen));
  const header = JSON.parse(headerStr);
  const payload = buf.subarray(headerStart + headerLen);

  switch (header.type) {
    case 'sync':
      return {
        type: 'sync',
        rev: header.rev,
        cols: header.cols,
        rows: header.rows,
        cursor: header.cursor,
        altScreen: header.altScreen,
        modes: header.modes,
        totalLines: header.totalLines,
        base: header.base ?? 0,
        cursorShape: header.cursorShape ?? 'block',
        cursorBlink: header.cursorBlink ?? false,
        runs: decodeRuns(payload),
      };
    case 'delta':
      return {
        type: 'delta',
        rev: header.rev,
        cursor: header.cursor,
        modes: header.modes,
        totalLines: header.totalLines,
        base: header.base ?? 0,
        cursorShape: header.cursorShape ?? 'block',
        cursorBlink: header.cursorBlink ?? false,
        runs: decodeRuns(payload),
      };
    case 'history':
      return {
        type: 'history',
        reqId: header.reqId,
        from: header.from,
        to: header.to,
        base: header.base ?? 0,
        runs: decodeRuns(payload),
      };
    case 'searchResult':
      return {
        type: 'searchResult',
        reqId: header.reqId,
        matches: header.matches,
        done: header.done,
      };
    default:
      throw new Error(`grid frame: unknown type ${header.type}`);
  }
}

// ---- Client → server frames (JSON; the daemon's parse_input_event + grid
// input loop read these). `type` is the discriminator: key/text/paste/mouse are
// input events; resize/fetch are control frames. ----

export interface Mods {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export type MouseAction = 'down' | 'up' | 'move' | 'wheelUp' | 'wheelDown';

export const inputKey = (key: string, mods: Mods = {}) =>
  JSON.stringify({ type: 'key', key, mods });
export const inputText = (text: string) => JSON.stringify({ type: 'text', text });
export const inputPaste = (text: string) => JSON.stringify({ type: 'paste', text });
export const inputMouse = (
  action: MouseAction,
  button: number,
  col: number,
  row: number,
  mods: Mods = {},
) => JSON.stringify({ type: 'mouse', action, button, col, row, mods });
export const resizeFrame = (cols: number, rows: number) =>
  JSON.stringify({ type: 'resize', cols, rows });
export const fetchFrame = (reqId: number, from: number, to: number) =>
  JSON.stringify({ type: 'fetch', reqId, from, to });
export const searchFrame = (reqId: number, query: string, limit = 1000, caseSensitive = false) =>
  JSON.stringify({ type: 'search', reqId, query, limit, caseSensitive });
export const cancelFrame = (reqId: number) => JSON.stringify({ type: 'cancel', reqId });
