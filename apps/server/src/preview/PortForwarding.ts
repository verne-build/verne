import {
  PreviewPortForwardUnavailableError,
  type LocalServerConnectHost,
  type PreviewPortForwardLeaseResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as PortScanner from "./PortScanner.ts";

const TICKET_TTL_MS = 60_000;
const MAX_ACTIVE_LEASES = 16;

interface LeaseEntry {
  readonly leaseId: string;
  readonly ticket: string | null;
  readonly sessionId: string;
  readonly port: number;
  readonly connectHost: LocalServerConnectHost;
  readonly expiresAtMillis: number;
  readonly revoked: Deferred.Deferred<void>;
}

export class PortForwardTicketInvalidError extends Schema.TaggedErrorClass<PortForwardTicketInvalidError>()(
  "PortForwardTicketInvalidError",
  {},
) {}

type AcquireError = PreviewPortForwardUnavailableError;

export class PortForwarding extends Context.Service<
  PortForwarding,
  {
    readonly acquire: (input: {
      readonly sessionId: string;
      readonly port: number;
    }) => Effect.Effect<PreviewPortForwardLeaseResult, AcquireError>;
    readonly consume: (input: {
      readonly sessionId: string;
      readonly ticket: string;
    }) => Effect.Effect<LeaseEntry, PortForwardTicketInvalidError>;
    readonly consumeTicket: (
      ticket: string,
    ) => Effect.Effect<LeaseEntry, PortForwardTicketInvalidError>;
    readonly release: (input: {
      readonly sessionId: string;
      readonly leaseId: string;
    }) => Effect.Effect<void>;
    readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
  }
>()("@verne-build/cli/preview/PortForwarding") {}

export const make = Effect.gen(function* () {
  const discovery = yield* PortScanner.PortDiscovery;
  const crypto = yield* Crypto.Crypto;
  const leasesRef = yield* Ref.make<ReadonlyMap<string, LeaseEntry>>(new Map());

  const acquire: PortForwarding["Service"]["acquire"] = Effect.fn("PortForwarding.acquire")(
    function* (input) {
      const server = (yield* discovery.scan()).find((candidate) => candidate.port === input.port);
      if (server === undefined) {
        return yield* new PreviewPortForwardUnavailableError({
          port: input.port,
          reason: "not-discovered",
        });
      }

      const connectHost = server.connectHost ?? "127.0.0.1";
      const nowDateTime = yield* DateTime.now;
      const now = nowDateTime.epochMilliseconds;
      const leaseId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const ticket = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const revoked = yield* Deferred.make<void>();
      const expiresAtMillis = now + TICKET_TTL_MS;
      const entry: LeaseEntry = {
        leaseId,
        ticket,
        sessionId: input.sessionId,
        port: input.port,
        connectHost,
        expiresAtMillis,
        revoked,
      };

      const accepted = yield* Ref.modify(leasesRef, (current) => {
        const active = new Map(
          [...current].filter(([, lease]) => lease.ticket === null || lease.expiresAtMillis > now),
        );
        for (const [id, lease] of active) {
          if (
            lease.ticket !== null &&
            lease.sessionId === input.sessionId &&
            lease.port === input.port
          ) {
            active.delete(id);
          }
        }
        if (active.size >= MAX_ACTIVE_LEASES) return [false, active] as const;
        active.set(leaseId, entry);
        return [true, active] as const;
      });
      if (!accepted) {
        return yield* new PreviewPortForwardUnavailableError({
          port: input.port,
          reason: "capacity",
        });
      }

      return {
        leaseId,
        ticket,
        port: input.port,
        connectHost,
        expiresAt: DateTime.formatIso(
          DateTime.add(nowDateTime, { seconds: TICKET_TTL_MS / 1_000 }),
        ),
      };
    },
  );

  const consumeStoredTicket = Effect.fn("PortForwarding.consumeStoredTicket")(function* (input: {
    readonly ticket: string;
    readonly sessionId?: string;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const entry = yield* Ref.modify(leasesRef, (current) => {
      const next = new Map(current);
      const match = [...next.values()].find(
        (lease) =>
          lease.ticket === input.ticket &&
          lease.expiresAtMillis > now &&
          (input.sessionId === undefined || lease.sessionId === input.sessionId),
      );
      if (match !== undefined) next.set(match.leaseId, { ...match, ticket: null });
      return [match, next] as const;
    });
    if (entry === undefined) {
      return yield* new PortForwardTicketInvalidError({});
    }
    return entry;
  });

  const consume: PortForwarding["Service"]["consume"] = consumeStoredTicket;

  const consumeTicket: PortForwarding["Service"]["consumeTicket"] = (ticket) =>
    consumeStoredTicket({ ticket });

  const release: PortForwarding["Service"]["release"] = (input) =>
    Ref.modify(leasesRef, (current) => {
      const lease = current.get(input.leaseId);
      if (lease?.sessionId !== input.sessionId) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(input.leaseId);
      return [lease, next] as const;
    }).pipe(
      Effect.flatMap((lease) =>
        lease === undefined ? Effect.void : Deferred.succeed(lease.revoked, undefined),
      ),
      Effect.asVoid,
    );

  const releaseSession: PortForwarding["Service"]["releaseSession"] = (sessionId) =>
    Ref.modify(leasesRef, (current) => {
      const removed = [...current.values()].filter((lease) => lease.sessionId === sessionId);
      return [
        removed,
        new Map([...current].filter(([, lease]) => lease.sessionId !== sessionId)),
      ] as const;
    }).pipe(
      Effect.flatMap((removed) =>
        Effect.forEach(removed, (lease) => Deferred.succeed(lease.revoked, undefined), {
          discard: true,
        }),
      ),
    );

  return PortForwarding.of({ acquire, consume, consumeTicket, release, releaseSession });
});

export const layer = Layer.effect(PortForwarding, make);
