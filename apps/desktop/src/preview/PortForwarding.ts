import * as NodeNet from "node:net";

import type {
  DesktopPortForwardClosedEvent,
  DesktopPortForwardEnsureInput,
  DesktopPortForwardEnsureResult,
  DesktopPortForwardReleaseInput,
} from "@t3tools/contracts";
import {
  decodePortForwardFrame,
  encodePortForwardFrame,
} from "@t3tools/shared/portForwardProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { PORT_FORWARD_CLOSED_CHANNEL } from "../ipc/channels.ts";

export interface DesktopPortForwardOwner {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
}

interface ForwardEntry {
  readonly key: string;
  readonly leaseId: string;
  readonly owner: DesktopPortForwardOwner;
  readonly server: NodeNet.Server;
  readonly webSocket: WebSocket;
  readonly sockets: Map<number, NodeNet.Socket>;
  closedEvent: DesktopPortForwardClosedEvent | undefined;
  readonly onOwnerDestroyed: () => void;
  rejectPending: ((error: DesktopPortForwardError) => void) | undefined;
  closed: boolean;
}

const MAX_CONCURRENT_STREAMS = 64;
const MAX_WEBSOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_TCP_WRITABLE_BYTES = 4 * 1024 * 1024;

export class DesktopPortForwardError extends Schema.TaggedErrorClass<DesktopPortForwardError>()(
  "DesktopPortForwardError",
  {
    operation: Schema.Literals(["connect", "listen"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation === "connect" ? "connect the remote tunnel" : "open the local forwarding port"}.`;
  }
}
const isDesktopPortForwardError = Schema.is(DesktopPortForwardError);

export class DesktopPortForwarding extends Context.Service<
  DesktopPortForwarding,
  {
    readonly ensure: (
      input: DesktopPortForwardEnsureInput,
      owner: DesktopPortForwardOwner,
    ) => Effect.Effect<DesktopPortForwardEnsureResult, DesktopPortForwardError>;
    readonly release: (
      input: DesktopPortForwardReleaseInput,
      owner: DesktopPortForwardOwner,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/preview/PortForwarding/DesktopPortForwarding") {}

const forwardKey = (input: { readonly environmentId: string; readonly remotePort: number }) =>
  `${input.environmentId}\u0000${input.remotePort}`;

const tunnelUrl = (input: DesktopPortForwardEnsureInput): string => {
  const url = new URL(input.httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/preview/tunnel";
  url.search = "";
  url.hash = "";
  url.searchParams.set("forwardTicket", input.forwardTicket);
  return url.href;
};

export const make = Effect.gen(function* () {
  const entries = new Map<string, ForwardEntry>();

  const closeEntry = (
    entry: ForwardEntry,
    pendingError = new DesktopPortForwardError({
      operation: "connect",
      cause: new Error("The forwarding listener was replaced or closed."),
    }),
  ) => {
    if (entry.closed) return;
    entry.closed = true;
    entry.owner.removeListener("destroyed", entry.onOwnerDestroyed);
    entry.server.close();
    for (const socket of entry.sockets.values()) socket.destroy();
    entry.sockets.clear();
    entry.webSocket.close();
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    const rejectPending = entry.rejectPending;
    entry.rejectPending = undefined;
    rejectPending?.(pendingError);
    if (entry.closedEvent !== undefined && !entry.owner.isDestroyed()) {
      try {
        entry.owner.send(PORT_FORWARD_CLOSED_CHANNEL, entry.closedEvent);
      } catch {
        // The renderer may disappear between isDestroyed() and send().
      }
    }
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of entries.values()) closeEntry(entry);
    }),
  );

  const ensure: DesktopPortForwarding["Service"]["ensure"] = Effect.fn(
    "DesktopPortForwarding.ensure",
  )((input, owner) =>
    Effect.tryPromise({
      try: () =>
        new Promise<DesktopPortForwardEnsureResult>((resolve, reject) => {
          const key = forwardKey(input);
          const previous = entries.get(key);
          if (previous) closeEntry(previous);

          const webSocket = new WebSocket(tunnelUrl(input));
          webSocket.binaryType = "arraybuffer";
          const server = NodeNet.createServer();
          const sockets = new Map<number, NodeNet.Socket>();
          let nextStreamId = 1;
          const entry: ForwardEntry = {
            key,
            leaseId: input.leaseId,
            owner,
            server,
            webSocket,
            sockets,
            closedEvent: undefined,
            onOwnerDestroyed: () =>
              closeEntry(
                entry,
                new DesktopPortForwardError({
                  operation: "connect",
                  cause: new Error("The forwarding renderer was destroyed."),
                }),
              ),
            rejectPending: reject,
            closed: false,
          };
          entries.set(key, entry);
          owner.once("destroyed", entry.onOwnerDestroyed);
          if (owner.isDestroyed()) {
            entry.onOwnerDestroyed();
            return;
          }
          const fail = (operation: "connect" | "listen", cause: unknown) =>
            closeEntry(entry, new DesktopPortForwardError({ operation, cause }));
          const send = (frame: Parameters<typeof encodePortForwardFrame>[0]) => {
            if (webSocket.readyState === WebSocket.OPEN) {
              if (webSocket.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) return false;
              webSocket.send(Uint8Array.from(encodePortForwardFrame(frame)).buffer);
              return true;
            }
            return false;
          };

          webSocket.addEventListener("error", (event) => fail("connect", event));
          webSocket.addEventListener("message", (event) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const frame = decodePortForwardFrame(new Uint8Array(event.data));
            if (frame === null || frame.type === "open" || frame.type === "keepalive") return;
            const socket = sockets.get(frame.streamId);
            if (!socket) return;
            if (frame.type === "data") {
              if (socket.writableLength > MAX_TCP_WRITABLE_BYTES) {
                socket.destroy();
                return;
              }
              socket.write(frame.data);
            } else if (frame.type === "end") socket.end();
            else {
              sockets.delete(frame.streamId);
              socket.destroy();
            }
          });
          webSocket.addEventListener("close", () => {
            closeEntry(
              entry,
              new DesktopPortForwardError({
                operation: "connect",
                cause: new Error("The remote forwarding tunnel closed."),
              }),
            );
          });
          webSocket.addEventListener("open", () => {
            if (entry.closed) return;
            server.on("connection", (socket) => {
              if (entry.closed) {
                socket.destroy();
                return;
              }
              if (sockets.size >= MAX_CONCURRENT_STREAMS) {
                socket.destroy();
                return;
              }
              const streamId = nextStreamId;
              nextStreamId = nextStreamId >= 0xffff_ffff ? 1 : nextStreamId + 1;
              sockets.set(streamId, socket);
              socket.setNoDelay(true);
              send({ type: "open", streamId });
              socket.on("data", (data) => {
                if (!send({ type: "data", streamId, data: new Uint8Array(data) })) {
                  socket.destroy();
                }
              });
              socket.on("end", () => send({ type: "end", streamId }));
              socket.on("error", () => socket.destroy());
              socket.on("close", () => {
                if (sockets.delete(streamId)) send({ type: "close", streamId });
              });
            });
            const listen = (port: number) => {
              const onError = (cause: NodeJS.ErrnoException) => {
                if (port !== 0 && cause.code === "EADDRINUSE") {
                  listen(0);
                  return;
                }
                fail("listen", cause);
              };
              server.once("error", onError);
              server.listen(port, "127.0.0.1", () => {
                server.off("error", onError);
                const address = server.address();
                if (address === null || typeof address === "string") {
                  fail("listen", new Error("Local forwarding listener has no TCP address."));
                  return;
                }
                const result = {
                  localPort: address.port,
                  localUrl: `http://localhost:${address.port}/`,
                } satisfies DesktopPortForwardEnsureResult;
                entry.closedEvent = {
                  environmentId: input.environmentId,
                  leaseId: input.leaseId,
                  remotePort: input.remotePort,
                  localPort: result.localPort,
                };
                entry.rejectPending = undefined;
                resolve(result);
              });
            };
            listen(input.remotePort);
          });
        }),
      catch: (cause) =>
        isDesktopPortForwardError(cause)
          ? cause
          : new DesktopPortForwardError({ operation: "connect", cause }),
    }),
  );

  const release: DesktopPortForwarding["Service"]["release"] = (input, owner) =>
    Effect.sync(() => {
      const entry = entries.get(forwardKey(input));
      if (entry?.leaseId === input.leaseId && entry.owner === owner) closeEntry(entry);
    });

  return DesktopPortForwarding.of({ ensure, release });
});

export const layer = Layer.effect(DesktopPortForwarding, make);
