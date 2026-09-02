import { it as effectIt } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as PortForwarding from "./PortForwarding.ts";
import * as PortScanner from "./PortScanner.ts";

const discovered = {
  host: "localhost",
  connectHost: "127.0.0.1" as const,
  port: 5173,
  url: "http://localhost:5173/",
  processName: "node",
  pid: 123,
  terminal: null,
};

let randomByte = 0;
const TestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill((randomByte += 1)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const layer = PortForwarding.layer.pipe(
  Layer.provide(
    Layer.succeed(PortScanner.PortDiscovery, {
      scan: () => Effect.succeed([discovered]),
      subscribe: () => Effect.void,
      retain: Effect.void,
      registerTerminalProcesses: () => Effect.void,
      unregisterTerminal: () => Effect.void,
    }),
  ),
  Layer.provide(TestCrypto),
);

effectIt.effect("issues and consumes a session-bound ticket exactly once", () =>
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    const lease = yield* forwarding.acquire({ sessionId: "session-a", port: 5173 });

    expect(lease.connectHost).toBe("127.0.0.1");
    expect((yield* forwarding.consume({ sessionId: "session-a", ticket: lease.ticket })).port).toBe(
      5173,
    );
    expect(
      (yield* Effect.flip(forwarding.consume({ sessionId: "session-a", ticket: lease.ticket })))
        ._tag,
    ).toBe("PortForwardTicketInvalidError");
  }).pipe(Effect.provide(layer)),
);

effectIt.effect("does not let another authenticated session consume a ticket", () =>
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    const lease = yield* forwarding.acquire({ sessionId: "session-a", port: 5173 });
    const error = yield* Effect.flip(
      forwarding.consume({ sessionId: "session-b", ticket: lease.ticket }),
    );
    expect(error._tag).toBe("PortForwardTicketInvalidError");
    expect((yield* forwarding.consume({ sessionId: "session-a", ticket: lease.ticket })).port).toBe(
      5173,
    );
  }).pipe(Effect.provide(layer)),
);

effectIt.effect("expires unconsumed tickets after sixty seconds", () =>
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    const lease = yield* forwarding.acquire({ sessionId: "session-a", port: 5173 });
    yield* TestClock.adjust(Duration.seconds(61));
    const error = yield* Effect.flip(
      forwarding.consume({ sessionId: "session-a", ticket: lease.ticket }),
    );
    expect(error._tag).toBe("PortForwardTicketInvalidError");
  }).pipe(Effect.provide(layer)),
);

effectIt.effect("rejects ports that are not currently discovered as browser-ready", () =>
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    const error = yield* Effect.flip(forwarding.acquire({ sessionId: "session-a", port: 9000 }));
    expect(error).toMatchObject({
      _tag: "PreviewPortForwardUnavailableError",
      port: 9000,
      reason: "not-discovered",
    });
  }).pipe(Effect.provide(layer)),
);

effectIt.effect("revokes every lease owned by a disconnected session", () =>
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    const lease = yield* forwarding.acquire({ sessionId: "session-a", port: 5173 });
    yield* forwarding.releaseSession("session-a");
    const error = yield* Effect.flip(
      forwarding.consume({ sessionId: "session-a", ticket: lease.ticket }),
    );
    expect(error._tag).toBe("PortForwardTicketInvalidError");
  }).pipe(Effect.provide(layer)),
);

effectIt.effect("revokes an active tunnel when its RPC session disconnects", () =>
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    const lease = yield* forwarding.acquire({ sessionId: "session-a", port: 5173 });
    const consumed = yield* forwarding.consumeTicket(lease.ticket);
    const revoked = yield* Deferred.await(consumed.revoked).pipe(Effect.as(true), Effect.forkChild);

    yield* forwarding.releaseSession("session-a");

    expect(yield* Fiber.join(revoked)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

effectIt.effect("keeps consumed tunnels inside the sixteen-lease capacity limit", () =>
  Effect.gen(function* () {
    const forwarding = yield* PortForwarding.PortForwarding;
    for (let index = 0; index < 16; index += 1) {
      const lease = yield* forwarding.acquire({ sessionId: "session-a", port: 5173 });
      yield* forwarding.consumeTicket(lease.ticket);
    }

    const error = yield* Effect.flip(forwarding.acquire({ sessionId: "session-a", port: 5173 }));
    expect(error).toMatchObject({ reason: "capacity" });
  }).pipe(Effect.provide(layer)),
);
