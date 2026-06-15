import net from "node:net";
import { encodeFrame, FrameDecoder } from "./daemon-codec";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type EventHandler = (name: string, payload: unknown) => void;

export class DaemonClient {
  private sock: net.Socket | null = null;
  private eventSock: net.Socket | null = null;
  private dec = new FrameDecoder();
  private eventDec = new FrameDecoder();
  private pending = new Map<number, Pending>();
  private eventHandlers: EventHandler[] = [];
  private nextId = 1;

  constructor(private readonly socketPath: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.socketPath);
      let settled = false;
      // Persistent error handler: a pre-connect failure (ECONNREFUSED) rejects
      // the promise once; a post-connect failure (daemon dies → ECONNRESET) is
      // swallowed here so it can't (a) throw an unhandled 'error' event that
      // crashes main, nor (b) reject an already-settled promise. The 'close'
      // handler below does the actual teardown.
      s.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      s.once("connect", () => { settled = true; this.sock = s; resolve(); });
      s.on("data", (d) => this.dec.push(d, (m) => this.dispatch(m as any)));
      s.on("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("daemon disconnected"));
        this.pending.clear();
        this.sock = null;
      });
    });
  }

  private dispatch(m: {
    type?: string;
    id?: number;
    result?: unknown;
    error?: { message: string };
    name?: string;
    payload?: unknown;
  }) {
    if (m.type === "event" && m.name) {
      for (const h of this.eventHandlers) h(m.name, m.payload);
      return;
    }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.sock) return Promise.reject(new Error("daemon not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock!.write(encodeFrame({ id, method, params: params ?? null }));
    });
  }

  /**
   * Subscribe to daemon events on a SEPARATE connection.
   *
   * The daemon decides a connection's mode from its first frame: a connection
   * whose first frame is `__subscribe_events` becomes event-only and never reads
   * another request (see rpc_server.rs handle_client). Sharing one socket would
   * therefore wedge all request/response traffic, so events get their own socket
   * and `this.sock` stays a normal request/response channel.
   */
  subscribeEvents(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.socketPath);
      let settled = false;
      // Same crash-safe pattern as connect(): reject once on a pre-connect error,
      // swallow post-connect errors (cleanup runs in 'close').
      s.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      s.once("connect", () => {
        settled = true;
        this.eventSock = s;
        s.write(encodeFrame({ id: 0, method: "__subscribe_events", params: null }));
        resolve();
      });
      s.on("data", (d) => this.eventDec.push(d, (m) => this.dispatch(m as any)));
      s.on("close", () => { this.eventSock = null; });
    });
  }

  onEvent(h: EventHandler): void { this.eventHandlers.push(h); }

  /**
   * Sends __shutdown to the daemon, then ends the socket.
   * Use this only when you explicitly want to stop the daemon process
   * (e.g. app quit, dev restart). The daemon will terminate.
   *
   * Tests use this because it cleanly ends the fake server connection.
   */
  close(): void {
    this.sock?.write(encodeFrame({ id: this.nextId++, method: "__shutdown", params: null }));
    this.sock?.end();
    this.eventSock?.end();
  }

  /**
   * Ends the socket WITHOUT sending __shutdown.
   * Use this for normal client teardown (tab close, window hide, reconnect).
   * The daemon keeps running and other clients remain unaffected.
   */
  disconnect(): void {
    this.sock?.end();
    this.eventSock?.end();
  }

  isConnected(): boolean { return this.sock !== null; }
}
