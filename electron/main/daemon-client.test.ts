import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { DaemonClient } from "./daemon-client";
import { encodeFrame, FrameDecoder } from "./daemon-codec";

let server: net.Server;
afterEach(() => server?.close());

function fakeDaemon(sock: string, handler: (msg: any, reply: (m: any) => void) => void) {
  // Clean up stale socket file if it exists
  try { unlinkSync(sock); } catch { /* ignore */ }
  server = net.createServer((c) => {
    const dec = new FrameDecoder();
    c.on("data", (d) => dec.push(d, (m) => handler(m, (out) => c.write(encodeFrame(out)))));
  });
  return new Promise<void>((res) => server.listen(sock, res));
}

describe("DaemonClient", () => {
  it("resolves a request with its response result", async () => {
    const sock = join(tmpdir(), `verne-test-${process.pid}.sock`);
    await fakeDaemon(sock, (msg, reply) => {
      if (msg.method === "ping") reply({ type: "response", id: msg.id, result: "pong" });
    });
    const client = new DaemonClient(sock);
    await client.connect();
    expect(await client.request("ping", null)).toBe("pong");
    client.close();
  });

  it("rejects on error response", async () => {
    const sock = join(tmpdir(), `verne-test-err-${process.pid}.sock`);
    await fakeDaemon(sock, (msg, reply) =>
      reply({ type: "response", id: msg.id, error: { message: "boom" } }));
    const client = new DaemonClient(sock);
    await client.connect();
    await expect(client.request("x", null)).rejects.toThrow("boom");
    client.close();
  });

  // Mimics the REAL daemon (rpc_server.rs handle_client): the first frame on a
  // connection decides its mode. A connection whose first frame is
  // __subscribe_events becomes event-only and never reads/answers further
  // frames. Regression guard: subscribing must NOT wedge request/response.
  function modeAwareDaemon(sock: string) {
    try { unlinkSync(sock); } catch { /* ignore */ }
    server = net.createServer((c) => {
      const dec = new FrameDecoder();
      let mode: "init" | "events" | "rpc" = "init";
      c.on("data", (d) => dec.push(d, (m: any) => {
        if (mode === "events") return; // event-only conn ignores all further frames
        if (mode === "init") {
          if (m.method === "__subscribe_events") {
            mode = "events";
            c.write(encodeFrame({ type: "response", id: m.id, result: null }));
            c.write(encodeFrame({ type: "event", name: "hello", payload: 1 }));
            return;
          }
          mode = "rpc";
        }
        if (m.method === "ping") c.write(encodeFrame({ type: "response", id: m.id, result: "pong" }));
      }));
    });
    return new Promise<void>((res) => server.listen(sock, res));
  }

  it("still serves requests after subscribing to events", async () => {
    const sock = join(tmpdir(), `verne-test-mode-${process.pid}.sock`);
    await modeAwareDaemon(sock);
    const client = new DaemonClient(sock);
    await client.connect();
    await client.subscribeEvents();
    // With a single shared socket this hangs forever: subscribeEvents put the
    // connection into event-only mode, so the daemon never reads this request.
    const result = await Promise.race([
      client.request("ping", null),
      new Promise((_, rej) => setTimeout(() => rej(new Error("request hung")), 1000)),
    ]);
    expect(result).toBe("pong");
    client.close();
  });

  it("delivers subscribed events", async () => {
    const sock = join(tmpdir(), `verne-test-ev-${process.pid}.sock`);
    await fakeDaemon(sock, (msg, reply) => {
      if (msg.method === "__subscribe_events") {
        reply({ type: "response", id: msg.id, result: null });
        reply({ type: "event", name: "tab-updated", payload: { tabId: "t1" } });
      }
    });
    const client = new DaemonClient(sock);
    await client.connect();
    const got = new Promise((res) => client.onEvent((name, payload) => res({ name, payload })));
    await client.subscribeEvents();
    expect(await got).toEqual({ name: "tab-updated", payload: { tabId: "t1" } });
    client.close();
  });
});
