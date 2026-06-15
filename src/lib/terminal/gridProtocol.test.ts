import { describe, it, expect } from 'vitest';
import {
  decodeFrame,
  inputKey,
  inputText,
  inputMouse,
  resizeFrame,
  fetchFrame,
  searchFrame,
  FLAG,
  colorKind,
  indexedColor,
  rgbColor,
  DEFAULT_COLOR,
} from './gridProtocol';

// --- byte-building helpers mirroring grid_protocol.rs layout ---
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

interface CellOpts {
  fg?: number[];
  bg?: number[];
  flags?: number;
  width?: number;
  zw?: number[];
  link?: string;
}
function cellBytes(cp: number, o: CellOpts = {}): number[] {
  const fg = o.fg ?? [0];
  const bg = o.bg ?? [0];
  let flags = o.flags ?? 0;
  const zw = o.zw ?? [];
  if (zw.length) flags |= FLAG.ZEROWIDTH;
  const zwTail = zw.length ? [zw.length, ...zw.flatMap(u32le)] : [];
  let linkTail: number[] = [];
  if (o.link !== undefined) {
    flags |= FLAG.HYPERLINK;
    const bytes = [...new TextEncoder().encode(o.link)];
    linkTail = [...u16le(bytes.length), ...bytes];
  }
  return [...u32le(cp), ...fg, ...bg, ...u16le(flags), o.width ?? 1, ...zwTail, ...linkTail];
}
const runBytes = (line: number, startCol: number, cells: number[][], wrapped = false) => [
  ...u16le(line),
  ...u16le(startCol),
  ...u16le(cells.length),
  wrapped ? 1 : 0, // [u8 wrapped] — wire contract
  ...cells.flat(),
];
function frame(header: object, payload: number[]): Uint8Array {
  const hb = new TextEncoder().encode(JSON.stringify(header));
  const len = hb.length;
  return new Uint8Array([
    0,
    (len >> 24) & 0xff,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
    ...hb,
    ...payload,
  ]);
}

describe('cell byte layout', () => {
  it('matches the daemon-asserted bytes for a plain default cell', () => {
    // grid_protocol.rs encodes_plain_default_cell asserts exactly this for 'A'.
    expect(cellBytes(0x41)).toEqual([0x41, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
});

describe('decodeFrame', () => {
  it('decodes a sync frame with cells and cursor', () => {
    const header = {
      type: 'sync',
      protocol: 2,
      rev: 1,
      cols: 3,
      rows: 1,
      cursor: [0, 1],
      altScreen: false,
      modes: { mouseReporting: false, altScreen: false, appCursor: true, bracketedPaste: false },
      totalLines: 5,
    };
    const payload = [...u16le(1), ...runBytes(0, 0, [cellBytes(72), cellBytes(105)])];
    const f = decodeFrame(frame(header, payload));
    expect(f.type).toBe('sync');
    if (f.type !== 'sync') throw new Error('not sync');
    expect(f.cols).toBe(3);
    expect(f.cursor).toEqual([0, 1]);
    expect(f.modes.appCursor).toBe(true);
    expect(f.runs[0].cells[0].cp).toBe(72); // 'H'
    expect(f.runs[0].cells[1].cp).toBe(105); // 'i'
  });

  it('decodes indexed and rgb colors', () => {
    const header = {
      type: 'delta',
      rev: 2,
      cursor: [0, 0],
      modes: { mouseReporting: false, altScreen: false, appCursor: false, bracketedPaste: false },
      totalLines: 0,
    };
    const cell = cellBytes(120, { fg: [1, 9], bg: [2, 1, 2, 3] });
    const payload = [...u16le(1), ...runBytes(0, 0, [cell])];
    const f = decodeFrame(frame(header, payload));
    if (f.type !== 'delta') throw new Error('not delta');
    const c = f.runs[0].cells[0];
    expect(c.fg).toBe(indexedColor(9));
    expect(colorKind(c.fg)).toBe(1);
    expect(c.bg).toBe(rgbColor(1, 2, 3));
    expect(colorKind(c.bg)).toBe(2);
  });

  it('decodes combining marks via the zerowidth tail', () => {
    const header = {
      type: 'delta',
      rev: 3,
      cursor: [0, 0],
      modes: { mouseReporting: false, altScreen: false, appCursor: false, bracketedPaste: false },
      totalLines: 0,
    };
    const cell = cellBytes(0x65, { zw: [0x301] }); // 'e' + combining acute
    const payload = [...u16le(1), ...runBytes(0, 0, [cell])];
    const f = decodeFrame(frame(header, payload));
    if (f.type !== 'delta') throw new Error('not delta');
    const c = f.runs[0].cells[0];
    expect(c.flags & FLAG.ZEROWIDTH).toBeTruthy();
    expect(c.zw).toEqual([0x301]);
  });

  it('decodes the OSC-8 hyperlink tail and shares one string per URI run', () => {
    const header = {
      type: 'delta',
      rev: 4,
      cursor: [0, 0],
      modes: { mouseReporting: false, altScreen: false, appCursor: false, bracketedPaste: false },
      totalLines: 0,
    };
    const uri = 'https://example.com';
    const payload = [
      ...u16le(1),
      ...runBytes(0, 0, [cellBytes(0x61, { link: uri }), cellBytes(0x62, { link: uri }), cellBytes(0x63)]),
    ];
    const f = decodeFrame(frame(header, payload));
    if (f.type !== 'delta') throw new Error('not delta');
    const [a, b, c] = f.runs[0].cells;
    expect(a.flags & FLAG.HYPERLINK).toBeTruthy();
    expect(a.link).toBe(uri);
    expect(b.link).toBe(uri);
    expect(a.link).toBe(b.link); // interned: same JS string reference
    expect(c.link).toBeUndefined();
  });

  it('decodes a history frame range', () => {
    const header = { type: 'history', reqId: 7, from: 10, to: 11 };
    const payload = [...u16le(1), ...runBytes(10, 0, [cellBytes(0x61)])];
    const f = decodeFrame(frame(header, payload));
    if (f.type !== 'history') throw new Error('not history');
    expect(f.reqId).toBe(7);
    expect(f.from).toBe(10);
    expect(f.runs[0].cells[0].cp).toBe(0x61);
  });

  it('default color decodes to DEFAULT_COLOR', () => {
    const header = {
      type: 'delta',
      rev: 1,
      cursor: [0, 0],
      modes: { mouseReporting: false, altScreen: false, appCursor: false, bracketedPaste: false },
      totalLines: 0,
    };
    const payload = [...u16le(1), ...runBytes(0, 0, [cellBytes(0x20)])];
    const f = decodeFrame(frame(header, payload)) as any;
    expect(f.runs[0].cells[0].fg).toBe(DEFAULT_COLOR);
  });

  it('decodes wrapped byte = 1 as wrapped:true', () => {
    const header = {
      type: 'delta',
      rev: 5,
      cursor: [0, 0],
      modes: { mouseReporting: false, altScreen: false, appCursor: false, bracketedPaste: false },
      totalLines: 2,
    };
    const payload = [...u16le(1), ...runBytes(0, 0, [cellBytes(0x41)], true)];
    const f = decodeFrame(frame(header, payload));
    if (f.type !== 'delta') throw new Error('not delta');
    expect(f.runs[0].wrapped).toBe(true);
  });

  it('decodes wrapped byte = 0 as wrapped:false', () => {
    const header = {
      type: 'delta',
      rev: 6,
      cursor: [0, 0],
      modes: { mouseReporting: false, altScreen: false, appCursor: false, bracketedPaste: false },
      totalLines: 2,
    };
    const payload = [...u16le(1), ...runBytes(0, 0, [cellBytes(0x42)], false)];
    const f = decodeFrame(frame(header, payload));
    if (f.type !== 'delta') throw new Error('not delta');
    expect(f.runs[0].wrapped).toBe(false);
  });
});

describe('searchFrame', () => {
  it('serializes query, limit and caseSensitive', () => {
    expect(JSON.parse(searchFrame(7, 'err', 500, true))).toEqual({
      type: 'search', reqId: 7, query: 'err', limit: 500, caseSensitive: true,
    });
  });
  it('defaults caseSensitive to false', () => {
    expect(JSON.parse(searchFrame(1, 'x')).caseSensitive).toBe(false);
  });
});

describe('client frames', () => {
  it('builds key/text/mouse/resize/fetch JSON', () => {
    expect(JSON.parse(inputKey('ArrowUp', { ctrl: true }))).toEqual({
      type: 'key',
      key: 'ArrowUp',
      mods: { ctrl: true },
    });
    expect(JSON.parse(inputText('hi'))).toEqual({ type: 'text', text: 'hi' });
    expect(JSON.parse(inputMouse('down', 0, 3, 4))).toEqual({
      type: 'mouse',
      action: 'down',
      button: 0,
      col: 3,
      row: 4,
      mods: {},
    });
    expect(JSON.parse(resizeFrame(80, 24))).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(JSON.parse(fetchFrame(1, 0, 5))).toEqual({ type: 'fetch', reqId: 1, from: 0, to: 5 });
  });
});
