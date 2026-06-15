// Transport for a grid (canvas) terminal session: opens a `?proto=grid`
// WebSocket, decodes daemon frames into a GridStore, and sends client input /
// resize / fetch frames. The socket is injectable so it's unit-testable without
// a real WebSocket (and so Electron vs test environments stay decoupled).

import { GridStore } from './GridStore';
import {
  cancelFrame,
  decodeFrame,
  fetchFrame,
  inputKey,
  inputMouse,
  inputPaste,
  inputText,
  resizeFrame,
  searchFrame,
  type Mods,
  type MouseAction,
  type SearchResultFrame,
} from './gridProtocol';

export interface GridSocket {
  binaryType: string;
  /** WebSocket.readyState (0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED).
   *  Optional so test fakes (which are always "ready") can omit it. */
  readyState?: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => GridSocket;

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as GridSocket;

function toUint8(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return null; // Blob / text frames aren't expected on the grid protocol
}

export class GridSession {
  readonly store: GridStore;
  /** Called after each applied grid frame so the renderer can repaint. */
  onUpdate?: () => void;
  /** Called when a search reply arrives. */
  onSearchResult?: (r: SearchResultFrame) => void;

  private sock: GridSocket | null = null;
  private readonly factory: SocketFactory;
  private readonly url: string;
  private nextReqId = 1;
  /** Frames queued while the socket is still CONNECTING; flushed on open. */
  private pending: string[] = [];
  /** Reconnect backoff: doubles per consecutive failure, reset on a received
   *  frame. Covers daemon restarts and dropped sockets beyond the sleep/resume
   *  path (reconnectAllTerminals), which stays as a fast-path nudge. */
  private static readonly RETRY_BASE_MS = 250;
  private static readonly RETRY_MAX_MS = 5000;
  private retryDelay = GridSession.RETRY_BASE_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(url: string, store: GridStore, factory: SocketFactory = defaultFactory) {
    this.url = url;
    this.store = store;
    this.factory = factory;
  }

  connect(): void {
    const sock = this.factory(this.url);
    sock.binaryType = 'arraybuffer';
    sock.onmessage = (ev) => this.onMessage(ev.data);
    sock.onopen = () => {
      for (const m of this.pending) sock.send(m);
      this.pending = [];
    };
    sock.onclose = () => this.scheduleReconnect();
    this.sock = sock;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer != null) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, GridSession.RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed) this.connect();
    }, delay);
  }

  private onMessage(data: unknown): void {
    const bytes = toUint8(data);
    if (!bytes) return;
    this.retryDelay = GridSession.RETRY_BASE_MS; // frames flowing → connection healthy
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return; // ignore malformed frames rather than tearing down the session
    }
    if (frame.type === 'searchResult') {
      this.onSearchResult?.(frame);
      return;
    }
    this.store.applyFrame(frame);
    this.onUpdate?.();
  }

  // ---- client → server ----

  sendKey(key: string, mods: Mods = {}): void {
    this.send(inputKey(key, mods));
  }

  sendText(text: string): void {
    this.send(inputText(text));
  }

  sendPaste(text: string): void {
    this.send(inputPaste(text));
  }

  sendMouse(action: MouseAction, button: number, col: number, row: number, mods: Mods = {}): void {
    this.send(inputMouse(action, button, col, row, mods));
  }

  resize(cols: number, rows: number): void {
    this.send(resizeFrame(cols, rows));
  }

  /** In-flight fetch reqIds (server may still be streaming chunks). */
  private inflight = new Set<number>();

  /** Request logical history `[from, to)`; returns the reqId used. */
  fetchHistory(from: number, to: number): number {
    const reqId = this.nextReqId++;
    this.inflight.add(reqId);
    this.send(fetchFrame(reqId, from, to));
    return reqId;
  }

  /** Tell the daemon to stop streaming a superseded fetch. No-op if unknown. */
  cancelHistory(reqId: number): void {
    if (!this.inflight.delete(reqId)) return;
    this.send(cancelFrame(reqId));
  }

  /** Cancel every in-flight fetch (resize / resync / reconnect). */
  cancelAllFetches(): void {
    for (const id of this.inflight) this.send(cancelFrame(id));
    this.inflight.clear();
  }

  inFlightFetches(): number[] {
    return [...this.inflight];
  }

  // (no per-frame inflight retire — chunks share a reqId; cancellation +
  // resync clear the set. Stale chunks are harmless: applyHistory caches by
  // stable id and clears pending per delivered range.)

  /** Search the full scrollback; results arrive via `onSearchResult`. */
  search(query: string, opts: { limit?: number; caseSensitive?: boolean } = {}): number {
    const reqId = this.nextReqId++;
    this.send(searchFrame(reqId, query, opts.limit ?? 1000, opts.caseSensitive ?? false));
    return reqId;
  }

  private send(s: string): void {
    const sock = this.sock;
    if (!sock) return;
    const rs = sock.readyState;
    if (rs === undefined || rs === 1) {
      sock.send(s); // OPEN, or a test fake (no readyState)
    } else if (rs === 0) {
      this.pending.push(s); // CONNECTING — flush on open
    }
    // CLOSING / CLOSED → drop
  }

  /** Reopen the socket if it has dropped (e.g. after system sleep). No-op while
   *  CONNECTING/OPEN. The server resyncs on reconnect (server-authoritative), so
   *  the existing store/renderer are reused. */
  reconnectIfClosed(): void {
    const rs = this.sock?.readyState;
    if (rs === 0 || rs === 1) return; // CONNECTING / OPEN
    this.inflight.clear(); // dead socket: drop in-flight tracking
    if (this.sock) {
      this.sock.onmessage = null;
      this.sock.onopen = null;
      this.sock.onclose = null;
    }
    this.sock = null;
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer != null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.sock) {
      this.sock.onmessage = null;
      this.sock.onclose = null;
      this.sock.close();
      this.sock = null;
    }
  }
}
