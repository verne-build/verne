import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, type DesktopPortForwardEnsureInput } from "@t3tools/contracts";
import {
  decodePortForwardFrame,
  encodePortForwardFrame,
} from "@t3tools/shared/portForwardProtocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, vi } from "vite-plus/test";

class MockWebSocket {
  static readonly OPEN = 1;
  static autoOpen = true;
  readonly sent: ArrayBuffer[] = [];
  private readonly sentWaiters: Array<{ readonly count: number; readonly resolve: () => void }> =
    [];
  binaryType = "blob";
  bufferedAmount = 0;
  readyState = 0;
  private closeListener: (() => void) | null = null;
  private errorListener: ((event: unknown) => void) | null = null;
  private messageListener: ((event: { readonly data: unknown }) => void) | null = null;
  private openListener: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
    if (MockWebSocket.autoOpen) queueMicrotask(() => this.open());
  }

  addEventListener(event: "close" | "error" | "message" | "open", listener: unknown) {
    if (event === "close") this.closeListener = listener as () => void;
    else if (event === "error") this.errorListener = listener as (event: unknown) => void;
    else if (event === "message") {
      this.messageListener = listener as (event: { readonly data: unknown }) => void;
    } else this.openListener = listener as () => void;
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.openListener?.();
  }

  emitClose() {
    this.closeListener?.();
  }

  emitMessage(data: ArrayBuffer) {
    this.messageListener?.({ data });
  }

  send(data: ArrayBuffer) {
    this.sent.push(data);
    for (const waiter of this.sentWaiters) {
      if (this.sent.length >= waiter.count) waiter.resolve();
    }
  }

  waitForSentCount(count: number) {
    if (this.sent.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => this.sentWaiters.push({ count, resolve }));
  }
}

const instances: MockWebSocket[] = [];

class TestOwner {
  readonly id: number;
  readonly sent: Array<{ readonly channel: string; readonly value: unknown }> = [];
  private destroyed = false;
  private readonly destroyedListeners = new Set<() => void>();

  constructor(id: number) {
    this.id = id;
  }

  isDestroyed() {
    return this.destroyed;
  }

  send(channel: string, value: unknown) {
    this.sent.push({ channel, value });
  }

  once(event: "destroyed", listener: () => void) {
    if (event === "destroyed") this.destroyedListeners.add(listener);
  }

  removeListener(event: "destroyed", listener: () => void) {
    if (event === "destroyed") this.destroyedListeners.delete(listener);
  }

  destroy() {
    this.destroyed = true;
    for (const listener of this.destroyedListeners) listener();
    this.destroyedListeners.clear();
  }
}

const input = (
  remotePort: number,
  leaseId: string,
  environmentId = "environment-1",
): DesktopPortForwardEnsureInput => ({
  environmentId: EnvironmentId.make(environmentId),
  leaseId,
  httpBaseUrl: "https://vps.example.com/",
  forwardTicket: `ticket-${leaseId}`,
  remotePort,
});

const reservePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No reserved address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

const connect = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });

const expectConnectionRejected = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Unexpectedly connected to released port ${port}.`));
    });
    socket.once("error", () => resolve());
  });

describe("DesktopPortForwarding", () => {
  afterEach(() => {
    instances.length = 0;
    MockWebSocket.autoOpen = true;
    vi.unstubAllGlobals();
  });

  effectIt.effect("keeps a replacement listener alive when the old websocket closes late", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", MockWebSocket);
      const remotePort = yield* Effect.promise(reservePort);
      const owner = new TestOwner(1);
      const PortForwarding = yield* Effect.promise(() => import("./PortForwarding.ts"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const forwarding = yield* PortForwarding.make;
          const first = yield* forwarding.ensure(input(remotePort, "lease-1"), owner);
          expect(first.localPort).toBe(remotePort);

          const second = yield* forwarding.ensure(input(remotePort, "lease-2"), owner);
          instances[0]?.emitClose();

          yield* Effect.promise(() => connect(second.localPort));
          expect(instances[1]?.sent.length).toBeGreaterThan(0);
        }),
      );
    }),
  );

  effectIt.effect("accepts only secure remote or loopback HTTP tunnel endpoints", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", MockWebSocket);
      const remotePort = yield* Effect.promise(reservePort);
      const owner = new TestOwner(1);
      const PortForwarding = yield* Effect.promise(() => import("./PortForwarding.ts"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const forwarding = yield* PortForwarding.make;
          const accepted = [
            {
              httpBaseUrl: "https://relay.example.test/control?ignored=1",
              expected: "wss://relay.example.test/preview/tunnel?forwardTicket=ticket-lease-1",
            },
            {
              httpBaseUrl: "https://192.168.1.25:3773/base",
              expected: "wss://192.168.1.25:3773/preview/tunnel?forwardTicket=ticket-lease-2",
            },
            {
              httpBaseUrl: "https://100.65.180.100:3773/base",
              expected: "wss://100.65.180.100:3773/preview/tunnel?forwardTicket=ticket-lease-3",
            },
            {
              httpBaseUrl: "http://127.0.0.1:43881/base?ignored=1",
              expected: "ws://127.0.0.1:43881/preview/tunnel?forwardTicket=ticket-lease-4",
            },
          ] as const;
          for (const [index, endpoint] of accepted.entries()) {
            yield* forwarding.ensure(
              {
                ...input(remotePort, `lease-${index + 1}`),
                httpBaseUrl: endpoint.httpBaseUrl,
              },
              owner,
            );
            expect(instances[index]?.url).toBe(endpoint.expected);
          }

          for (const [index, httpBaseUrl] of [
            "http://192.168.1.25:3773",
            "http://100.65.180.100:3773",
            "http://relay.example.test:3773",
            "ftp://relay.example.test/resource",
            "file:///tmp/server",
            "https://user:password@relay.example.test",
            "https://relay.example.test/#secret",
          ].entries()) {
            const before = instances.length;
            const exit = yield* forwarding
              .ensure(
                {
                  ...input(remotePort, `rejected-${index}`),
                  httpBaseUrl,
                },
                owner,
              )
              .pipe(Effect.exit);
            expect(exit._tag).toBe("Failure");
            expect(instances).toHaveLength(before);
          }
        }),
      );
    }),
  );

  effectIt.effect("cancels a pending listener when the same environment port is replaced", () =>
    Effect.gen(function* () {
      MockWebSocket.autoOpen = false;
      vi.stubGlobal("WebSocket", MockWebSocket);
      const remotePort = yield* Effect.promise(reservePort);
      const owner = new TestOwner(1);
      const PortForwarding = yield* Effect.promise(() => import("./PortForwarding.ts"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const forwarding = yield* PortForwarding.make;
          const first = yield* forwarding
            .ensure(input(remotePort, "lease-1"), owner)
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          const second = yield* forwarding
            .ensure(input(remotePort, "lease-2"), owner)
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;

          instances[0]?.open();
          instances[1]?.open();

          const firstExit = yield* Fiber.join(first);
          expect(firstExit._tag).toBe("Failure");
          const secondExit = yield* Fiber.join(second);
          expect(secondExit._tag).toBe("Success");
          if (secondExit._tag === "Failure") return;
          expect(secondExit.value.localPort).toBe(remotePort);
          yield* Effect.promise(() => connect(secondExit.value.localPort));
        }),
      );
    }),
  );

  effectIt.effect("binds IPv4 loopback, prefers the remote port, and bridges framed streams", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", MockWebSocket);
      const remotePort = yield* Effect.promise(reservePort);
      const owner = new TestOwner(1);
      const PortForwarding = yield* Effect.promise(() => import("./PortForwarding.ts"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const forwarding = yield* PortForwarding.make;
          const result = yield* forwarding.ensure(input(remotePort, "lease-1"), owner);
          expect(result).toEqual({
            localPort: remotePort,
            localUrl: `http://localhost:${remotePort}/`,
          });

          const socket = NodeNet.createConnection({ host: "127.0.0.1", port: result.localPort });
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
              }),
          );
          socket.write("hello");
          yield* Effect.promise(() => instances[0]?.waitForSentCount(2) ?? Promise.resolve());

          expect(
            instances[0]?.sent.map((frame) => decodePortForwardFrame(new Uint8Array(frame))),
          ).toEqual([
            { type: "open", streamId: 1 },
            { type: "data", streamId: 1, data: new Uint8Array(Buffer.from("hello")) },
          ]);
          const response = new Promise<Buffer>((resolve) => socket.once("data", resolve));
          instances[0]?.emitMessage(
            Uint8Array.from(
              encodePortForwardFrame({
                type: "data",
                streamId: 1,
                data: new Uint8Array(Buffer.from("world")),
              }),
            ).buffer,
          );
          expect((yield* Effect.promise(() => response)).toString()).toBe("world");
          socket.destroy();
        }),
      );
    }),
  );

  effectIt.effect("falls back to another loopback port when the requested port is occupied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("WebSocket", MockWebSocket);
        const occupied = NodeNet.createServer();
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              occupied.once("error", reject);
              occupied.listen(0, "127.0.0.1", resolve);
            }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => new Promise<void>((resolve) => occupied.close(() => resolve()))),
        );
        const address = occupied.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new Error("No occupied address"));
        }
        const PortForwarding = yield* Effect.promise(() => import("./PortForwarding.ts"));
        const forwarding = yield* PortForwarding.make;
        const result = yield* forwarding.ensure(input(address.port, "lease-1"), new TestOwner(1));
        expect(result.localPort).not.toBe(address.port);
        yield* Effect.promise(() => connect(result.localPort));
      }),
    ),
  );

  effectIt.effect("does not let stale leases or another renderer release a replacement", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", MockWebSocket);
      const remotePort = yield* Effect.promise(reservePort);
      const owner = new TestOwner(1);
      const otherOwner = new TestOwner(2);
      const PortForwarding = yield* Effect.promise(() => import("./PortForwarding.ts"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const forwarding = yield* PortForwarding.make;
          yield* forwarding.ensure(input(remotePort, "lease-1"), owner);
          const replacement = yield* forwarding.ensure(input(remotePort, "lease-2"), owner);

          yield* forwarding.release(
            {
              environmentId: EnvironmentId.make("environment-1"),
              leaseId: "lease-1",
              remotePort,
            },
            owner,
          );
          yield* forwarding.release(
            {
              environmentId: EnvironmentId.make("environment-1"),
              leaseId: "lease-2",
              remotePort,
            },
            otherOwner,
          );

          yield* Effect.promise(() => connect(replacement.localPort));
          yield* forwarding.release(
            {
              environmentId: EnvironmentId.make("environment-1"),
              leaseId: "lease-2",
              remotePort,
            },
            owner,
          );
          yield* Effect.promise(() => expectConnectionRejected(replacement.localPort));
          expect(owner.sent.at(-1)?.value).toEqual({
            environmentId: "environment-1",
            leaseId: "lease-2",
            remotePort,
            localPort: replacement.localPort,
          });
          expect(otherOwner.sent).toEqual([]);
        }),
      );
    }),
  );

  effectIt.effect("closes only listeners owned by a destroyed renderer", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", MockWebSocket);
      const firstPort = yield* Effect.promise(reservePort);
      const secondPort = yield* Effect.promise(reservePort);
      const firstOwner = new TestOwner(1);
      const secondOwner = new TestOwner(2);
      const PortForwarding = yield* Effect.promise(() => import("./PortForwarding.ts"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const forwarding = yield* PortForwarding.make;
          const first = yield* forwarding.ensure(input(firstPort, "lease-1"), firstOwner);
          const second = yield* forwarding.ensure(
            input(secondPort, "lease-2", "environment-2"),
            secondOwner,
          );

          firstOwner.destroy();

          yield* Effect.promise(() => expectConnectionRejected(first.localPort));
          yield* Effect.promise(() => connect(second.localPort));
        }),
      );
    }),
  );
});
