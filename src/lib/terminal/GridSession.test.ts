import { describe, it, expect, vi } from 'vitest';
import { GridSession, type GridSocket } from './GridSession';
import { GridStore } from './GridStore';

class FakeSocket implements GridSocket {
  binaryType = '';
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  push(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.buffer });
  }
}

// Build a minimal sync frame (one row "Hi", cols 5, rows 1).
function syncFrame(): Uint8Array {
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const cell = (cp: number) => [...[cp & 0xff, 0, 0, 0], 0, 0, ...u16(0), 1];
  const run = [...u16(0), ...u16(0), ...u16(2), 0, ...cell(72), ...cell(105)]; // 0 = wrapped byte
  const payload = [...u16(1), ...run];
  const header = JSON.stringify({
    type: 'sync',
    protocol: 2,
    rev: 1,
    cols: 5,
    rows: 1,
    cursor: [0, 2],
    altScreen: false,
    modes: { mouseReporting: false, altScreen: false, appCursor: false, bracketedPaste: false },
    totalLines: 1,
  });
  const hb = new TextEncoder().encode(header);
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

function setup() {
  let sock!: FakeSocket;
  const store = new GridStore();
  const session = new GridSession('ws://x/session/s?proto=grid', store, (_url) => {
    sock = new FakeSocket();
    return sock;
  });
  session.connect();
  return { store, session, sock };
}

function multiSetup() {
  vi.useFakeTimers();
  const socks: FakeSocket[] = [];
  const store = new GridStore();
  const session = new GridSession('ws://x?proto=grid', store, () => {
    const s = new FakeSocket();
    socks.push(s);
    return s;
  });
  session.connect();
  return { session, socks };
}

describe('GridSession cancellation', () => {
  it('sends a cancel frame for an in-flight fetch and tracks reqIds', () => {
    const { session, sock } = setup();
    const a = session.fetchHistory(0, 10);
    const b = session.fetchHistory(10, 20);
    expect(a).not.toBe(b);
    expect(session.inFlightFetches()).toContain(a);
    session.cancelHistory(a);
    const cancelFrames = sock.sent.filter((m) => JSON.parse(m).type === 'cancel');
    expect(cancelFrames.map((m) => JSON.parse(m).reqId)).toEqual([a]);
    expect(session.inFlightFetches()).not.toContain(a);
    expect(session.inFlightFetches()).toContain(b);
  });

  it('cancelAllFetches cancels every in-flight fetch', () => {
    const { session, sock } = setup();
    const a = session.fetchHistory(0, 10);
    const b = session.fetchHistory(10, 20);
    session.cancelAllFetches();
    const ids = sock.sent
      .filter((m) => JSON.parse(m).type === 'cancel')
      .map((m) => JSON.parse(m).reqId);
    expect(new Set(ids)).toEqual(new Set([a, b]));
    expect(session.inFlightFetches()).toHaveLength(0);
  });

  it('cancelHistory is a no-op for an unknown reqId', () => {
    const { session, sock } = setup();
    const before = sock.sent.length;
    session.cancelHistory(9999);
    expect(sock.sent.length).toBe(before); // no cancel frame sent
  });

  it('reconnectIfClosed clears in-flight set', () => {
    const { session, sock } = setup();
    session.fetchHistory(0, 10);
    expect(session.inFlightFetches()).toHaveLength(1);
    // Simulate a closed socket (readyState 3 = CLOSED).
    (sock as FakeSocket & { readyState: number }).readyState = 3;
    session.reconnectIfClosed();
    expect(session.inFlightFetches()).toHaveLength(0);
  });
});

describe('GridSession', () => {
  it('sets arraybuffer binaryType on connect', () => {
    const { sock } = setup();
    expect(sock.binaryType).toBe('arraybuffer');
  });

  it('decodes incoming frames into the store and notifies', () => {
    const { store, session, sock } = setup();
    let updates = 0;
    session.onUpdate = () => updates++;
    sock.push(syncFrame());
    expect(store.cols).toBe(5);
    expect(store.cursor).toEqual([0, 2]);
    expect(String.fromCodePoint(store.screen[0][0].cp, store.screen[0][1].cp)).toBe('Hi');
    expect(updates).toBe(1);
  });

  it('ignores malformed frames without throwing', () => {
    const { session, sock } = setup();
    expect(() => sock.push(new Uint8Array([9, 9, 9]))).not.toThrow();
    void session;
  });

  it('serializes input/resize/fetch to the socket', () => {
    const { session, sock } = setup();
    session.sendKey('ArrowUp', { ctrl: true });
    session.sendText('hi');
    session.resize(80, 24);
    const id = session.fetchHistory(0, 10);
    expect(JSON.parse(sock.sent[0])).toEqual({ type: 'key', key: 'ArrowUp', mods: { ctrl: true } });
    expect(JSON.parse(sock.sent[1])).toEqual({ type: 'text', text: 'hi' });
    expect(JSON.parse(sock.sent[2])).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(JSON.parse(sock.sent[3])).toEqual({ type: 'fetch', reqId: id, from: 0, to: 10 });
  });

  it('closes the socket on dispose', () => {
    const { session, sock } = setup();
    session.dispose();
    expect(sock.closed).toBe(true);
  });

  it('reconnects after close with doubling backoff', () => {
    const { socks } = multiSetup();
    expect(socks.length).toBe(1);
    socks[0].onclose?.({});
    vi.advanceTimersByTime(250);
    expect(socks.length).toBe(2);
    socks[1].onclose?.({});
    vi.advanceTimersByTime(499);
    expect(socks.length).toBe(2); // backoff doubled to 500ms — not yet
    vi.advanceTimersByTime(1);
    expect(socks.length).toBe(3);
    vi.useRealTimers();
  });

  it('resets the backoff once a frame arrives', () => {
    const { socks } = multiSetup();
    socks[0].onclose?.({});
    vi.advanceTimersByTime(250); // 2nd socket; next delay would be 500ms
    socks[1].push(syncFrame()); // healthy connection → reset
    socks[1].onclose?.({});
    vi.advanceTimersByTime(250); // back to the base delay
    expect(socks.length).toBe(3);
    vi.useRealTimers();
  });

  it('does not reconnect after dispose', () => {
    const { session, socks } = multiSetup();
    socks[0].onclose?.({});
    session.dispose();
    vi.advanceTimersByTime(10_000);
    expect(socks.length).toBe(1);
    vi.useRealTimers();
  });

  it('queues sends while CONNECTING and flushes on open', () => {
    let sock!: FakeSocket & { readyState: number };
    const store = new GridStore();
    const session = new GridSession('ws://x?proto=grid', store, () => {
      const s = new FakeSocket() as FakeSocket & { readyState: number };
      s.readyState = 0; // CONNECTING
      sock = s;
      return s;
    });
    session.connect();
    session.resize(80, 24); // sent before open → must not throw, must queue
    expect(sock.sent.length).toBe(0);
    sock.readyState = 1; // OPEN
    sock.onopen?.({});
    expect(JSON.parse(sock.sent[0])).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });
});
