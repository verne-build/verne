import * as NodeNet from "node:net";

import {
  decodePortForwardFrame,
  encodePortForwardFrame,
  type PortForwardFrame,
} from "@t3tools/shared/portForwardProtocol";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as PortForwarding from "./PortForwarding.ts";

const MAX_CONCURRENT_STREAMS = 64;
const MAX_QUEUED_FRAMES = 8;

const writeTcp = (socket: NodeNet.Socket, data: Uint8Array): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) {
      resume(Effect.void);
      return;
    }
    socket.write(data, (error) =>
      resume(error === null || error === undefined ? Effect.void : Effect.void),
    );
  });

const runTunnel = (
  webSocket: Socket.Socket,
  target: { readonly connectHost: "127.0.0.1" | "::1"; readonly port: number },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* webSocket.writer;
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const streams = new Map<number, NodeNet.Socket>();
      const outbound = yield* Queue.dropping<PortForwardFrame>(MAX_QUEUED_FRAMES);
      const send = (frame: PortForwardFrame) =>
        Queue.offer(outbound, frame).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : writer(new Socket.CloseEvent(1013, "Tunnel buffer limit exceeded")),
          ),
        );
      const forkSend = (frame: PortForwardFrame, source?: NodeNet.Socket) =>
        runFork(
          send(frame).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                source?.destroy();
              }),
            ),
          ),
        );

      yield* Effect.forever(
        Queue.take(outbound).pipe(Effect.flatMap((frame) => writer(encodePortForwardFrame(frame)))),
      ).pipe(Effect.forkChild);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const socket of streams.values()) socket.destroy();
          streams.clear();
        }).pipe(
          Effect.andThen(
            writer(new Socket.CloseEvent(1000, "Forward closed")).pipe(
              Effect.catch(() => Effect.void),
            ),
          ),
        ),
      );

      yield* webSocket.run((raw) => {
        const frame = decodePortForwardFrame(raw);
        if (frame === null) return writer(new Socket.CloseEvent(1002, "Invalid tunnel frame"));
        if (frame.type === "keepalive") return send(frame);
        if (frame.type === "open") {
          if (streams.has(frame.streamId) || streams.size >= MAX_CONCURRENT_STREAMS) {
            return send({ type: "close", streamId: frame.streamId });
          }
          return Effect.sync(() => {
            const tcp = NodeNet.createConnection({ host: target.connectHost, port: target.port });
            tcp.setNoDelay(true);
            streams.set(frame.streamId, tcp);
            tcp.on("data", (chunk) =>
              forkSend(
                { type: "data", streamId: frame.streamId, data: new Uint8Array(chunk) },
                tcp,
              ),
            );
            tcp.on("end", () => forkSend({ type: "end", streamId: frame.streamId }));
            tcp.on("error", () => tcp.destroy());
            tcp.on("close", () => {
              if (streams.delete(frame.streamId)) {
                forkSend({ type: "close", streamId: frame.streamId });
              }
            });
          });
        }
        const tcp = streams.get(frame.streamId);
        if (tcp === undefined) return Effect.void;
        if (frame.type === "data") return writeTcp(tcp, frame.data);
        if (frame.type === "end") {
          return Effect.sync(() => tcp.end());
        }
        return Effect.sync(() => tcp.destroy());
      });
    }),
  );

export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    return HttpRouter.add(
      "GET",
      "/preview/tunnel",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const forwardTicket = new URL(request.url, "http://localhost").searchParams.get(
          "forwardTicket",
        );
        if (forwardTicket === null) return HttpServerResponse.text("Unauthorized", { status: 401 });
        const lease = yield* forwarding.consumeTicket(forwardTicket).pipe(Effect.option);
        if (lease._tag === "None") {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        yield* Effect.gen(function* () {
          const webSocket = yield* request.upgrade;
          yield* Effect.raceFirst(
            runTunnel(webSocket, lease.value),
            Deferred.await(lease.value.revoked),
          );
        }).pipe(
          Effect.catch(() => Effect.void),
          Effect.ensuring(
            forwarding.release({
              sessionId: lease.value.sessionId,
              leaseId: lease.value.leaseId,
            }),
          ),
        );
        return HttpServerResponse.empty();
      }),
    );
  }),
);
