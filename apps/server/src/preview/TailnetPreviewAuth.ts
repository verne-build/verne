import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

const DEFAULT_LAUNCH_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_ACTIVE_LAUNCHES = 128;
const DEFAULT_MAX_ACTIVE_SESSIONS = 128;
const TARGET_ORIGIN = "https://preview.invalid";

export interface TailnetPreviewLaunchBinding {
  readonly environmentId: string;
  readonly port: number;
  readonly leaseId: string;
  readonly target: string;
}

export interface TailnetPreviewLaunchCapability {
  readonly launchSecret: string;
  readonly expiresAt: string;
}

export interface TailnetPreviewLaunchExchange {
  readonly environmentId: string;
  readonly port: number;
  readonly leaseId: string;
  readonly launchSecret: string;
}

export interface TailnetPreviewGatewaySession {
  readonly sessionSecret: string;
  readonly cookieName: string;
  readonly expiresAt: string;
}

export interface TailnetPreviewSessionValidation {
  readonly environmentId: string;
  readonly port: number;
  readonly leaseId: string;
  readonly sessionSecret: string;
}

export interface TailnetPreviewGatewayBinding extends TailnetPreviewLaunchBinding {
  readonly cookieName: string;
}

export interface TailnetPreviewAuthOptions {
  readonly launchTtlMs: number;
  readonly sessionTtlMs: number;
  readonly maxActiveLaunches: number;
  readonly maxActiveSessions: number;
  readonly maxUsedLaunchTombstones: number;
  readonly maxRevokedLaunchTombstones: number;
  readonly maxRevokedSessionTombstones: number;
}

export class TailnetPreviewAuthCapacityError extends Schema.TaggedErrorClass<TailnetPreviewAuthCapacityError>()(
  "TailnetPreviewAuthCapacityError",
  {
    resource: Schema.Literals(["launch", "session"]),
  },
) {}

export class TailnetPreviewTargetInvalidError extends Schema.TaggedErrorClass<TailnetPreviewTargetInvalidError>()(
  "TailnetPreviewTargetInvalidError",
  {
    reason: Schema.Literals([
      "absolute-url",
      "control-character",
      "empty",
      "network-path",
      "not-relative",
    ]),
  },
) {}

export class TailnetPreviewLaunchInvalidError extends Schema.TaggedErrorClass<TailnetPreviewLaunchInvalidError>()(
  "TailnetPreviewLaunchInvalidError",
  {
    reason: Schema.Literals(["binding-mismatch", "expired", "replayed", "revoked", "unknown"]),
  },
) {}

export class TailnetPreviewSessionInvalidError extends Schema.TaggedErrorClass<TailnetPreviewSessionInvalidError>()(
  "TailnetPreviewSessionInvalidError",
  {
    reason: Schema.Literals(["binding-mismatch", "expired", "revoked", "unknown"]),
  },
) {}

const isTailnetPreviewTargetInvalidError = Schema.is(TailnetPreviewTargetInvalidError);

interface LaunchRecord extends TailnetPreviewLaunchBinding {
  readonly secretDigest: string;
  readonly expiresAtMillis: number;
}

interface SessionRecord extends TailnetPreviewGatewayBinding {
  readonly secretDigest: string;
  readonly expiresAtMillis: number;
}

interface RevokedTokenRecord {
  readonly leaseId: string;
  readonly expiresAtMillis: number;
}

interface UsedLaunchRecord extends RevokedTokenRecord {}

interface TailnetPreviewAuthState {
  readonly launches: ReadonlyMap<string, LaunchRecord>;
  readonly usedLaunches: ReadonlyMap<string, UsedLaunchRecord>;
  readonly sessions: ReadonlyMap<string, SessionRecord>;
  readonly revokedLaunches: ReadonlyMap<string, RevokedTokenRecord>;
  readonly revokedSessions: ReadonlyMap<string, RevokedTokenRecord>;
}

type AuthDecision<A, E> = readonly [Effect.Effect<A, E>, TailnetPreviewAuthState];
type MintLaunchDecision = AuthDecision<
  TailnetPreviewLaunchCapability,
  TailnetPreviewAuthCapacityError
>;
type ExchangeLaunchDecision = AuthDecision<
  TailnetPreviewGatewaySession,
  TailnetPreviewAuthCapacityError | TailnetPreviewLaunchInvalidError
>;
type ValidateSessionDecision = AuthDecision<
  TailnetPreviewGatewayBinding,
  TailnetPreviewSessionInvalidError
>;

export interface TailnetPreviewAuthStateSnapshot {
  readonly launches: ReadonlyArray<LaunchRecord>;
  readonly sessions: ReadonlyArray<SessionRecord>;
  readonly usedLaunches: ReadonlyArray<UsedLaunchRecord>;
  readonly revokedLaunches: ReadonlyArray<RevokedTokenRecord>;
  readonly revokedSessions: ReadonlyArray<RevokedTokenRecord>;
}

const defaultOptions: TailnetPreviewAuthOptions = {
  launchTtlMs: DEFAULT_LAUNCH_TTL_MS,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  maxActiveLaunches: DEFAULT_MAX_ACTIVE_LAUNCHES,
  maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS,
  maxUsedLaunchTombstones: DEFAULT_MAX_ACTIVE_LAUNCHES,
  maxRevokedLaunchTombstones: DEFAULT_MAX_ACTIVE_LAUNCHES,
  maxRevokedSessionTombstones: DEFAULT_MAX_ACTIVE_SESSIONS,
};

const initialState: TailnetPreviewAuthState = {
  launches: new Map(),
  usedLaunches: new Map(),
  sessions: new Map(),
  revokedLaunches: new Map(),
  revokedSessions: new Map(),
};

const cookieNameForPort = (port: number) => `__Host-verne-preview-${port}`;

const expiresAtIso = (expiresAtMillis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis));

const normalizeOptions = (
  options: Partial<TailnetPreviewAuthOptions> | undefined,
): TailnetPreviewAuthOptions => ({
  launchTtlMs: options?.launchTtlMs ?? defaultOptions.launchTtlMs,
  sessionTtlMs: options?.sessionTtlMs ?? defaultOptions.sessionTtlMs,
  maxActiveLaunches: options?.maxActiveLaunches ?? defaultOptions.maxActiveLaunches,
  maxActiveSessions: options?.maxActiveSessions ?? defaultOptions.maxActiveSessions,
  maxUsedLaunchTombstones:
    options?.maxUsedLaunchTombstones ?? defaultOptions.maxUsedLaunchTombstones,
  maxRevokedLaunchTombstones:
    options?.maxRevokedLaunchTombstones ?? defaultOptions.maxRevokedLaunchTombstones,
  maxRevokedSessionTombstones:
    options?.maxRevokedSessionTombstones ?? defaultOptions.maxRevokedSessionTombstones,
});

const cloneMap = <K, V>(source: ReadonlyMap<K, V>) => new Map(source);

const trimOldestToSize = <V>(source: Map<string, V>, maxEntries: number): Map<string, V> => {
  while (source.size > maxEntries) {
    const oldestKey = source.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    source.delete(oldestKey);
  }
  return source;
};

const setBoundedEntry = <V>(
  source: ReadonlyMap<string, V>,
  key: string,
  value: V,
  maxEntries: number,
): Map<string, V> => {
  const next = cloneMap(source);
  if (next.has(key)) {
    next.delete(key);
  }
  next.set(key, value);
  return trimOldestToSize(next, maxEntries);
};

const pruneByExpiry = <V extends { readonly expiresAtMillis: number }>(
  source: ReadonlyMap<string, V>,
  now: number,
) => new Map([...source].filter(([, value]) => value.expiresAtMillis > now));

const pruneState = (state: TailnetPreviewAuthState, now: number): TailnetPreviewAuthState => ({
  launches: pruneByExpiry(state.launches, now),
  usedLaunches: pruneByExpiry(state.usedLaunches, now),
  sessions: pruneByExpiry(state.sessions, now),
  revokedLaunches: pruneByExpiry(state.revokedLaunches, now),
  revokedSessions: pruneByExpiry(state.revokedSessions, now),
});

const hasControlCharacter = (value: string) => /[\u0000-\u001f\u007f]/u.test(value);

const validateRelativeTarget = (
  target: string,
): Effect.Effect<string, TailnetPreviewTargetInvalidError> => {
  if (target.length === 0) {
    return Effect.fail(new TailnetPreviewTargetInvalidError({ reason: "empty" }));
  }
  if (hasControlCharacter(target)) {
    return Effect.fail(new TailnetPreviewTargetInvalidError({ reason: "control-character" }));
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) {
    return Effect.fail(new TailnetPreviewTargetInvalidError({ reason: "absolute-url" }));
  }
  if (target.startsWith("//")) {
    return Effect.fail(new TailnetPreviewTargetInvalidError({ reason: "network-path" }));
  }
  if (!target.startsWith("/")) {
    return Effect.fail(new TailnetPreviewTargetInvalidError({ reason: "not-relative" }));
  }

  return Effect.try({
    try: () => {
      const parsed = new URL(target, TARGET_ORIGIN);
      if (parsed.origin !== TARGET_ORIGIN) {
        throw new TailnetPreviewTargetInvalidError({ reason: "absolute-url" });
      }
      const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      if (normalized !== target) {
        throw new TailnetPreviewTargetInvalidError({ reason: "not-relative" });
      }
      return normalized;
    },
    catch: (cause) =>
      isTailnetPreviewTargetInvalidError(cause)
        ? cause
        : new TailnetPreviewTargetInvalidError({ reason: "not-relative" }),
  });
};

const timingSafeDigestEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const bindingMatches = (
  record: Pick<TailnetPreviewLaunchBinding, "environmentId" | "port" | "leaseId">,
  input: Pick<TailnetPreviewLaunchExchange, "environmentId" | "port" | "leaseId">,
) =>
  record.environmentId === input.environmentId &&
  record.port === input.port &&
  record.leaseId === input.leaseId;

const sortedValues = <T extends { readonly leaseId: string; readonly port: number }>(
  source: ReadonlyMap<string, T>,
) =>
  [...source.values()].sort(
    (left, right) => left.leaseId.localeCompare(right.leaseId) || left.port - right.port,
  );

const sortedTombstones = <T extends { readonly leaseId: string; readonly expiresAtMillis: number }>(
  source: ReadonlyMap<string, T>,
) =>
  [...source.values()].sort(
    (left, right) =>
      left.leaseId.localeCompare(right.leaseId) || left.expiresAtMillis - right.expiresAtMillis,
  );

export class TailnetPreviewAuth extends Context.Service<
  TailnetPreviewAuth,
  {
    readonly mintLaunch: (
      binding: TailnetPreviewLaunchBinding,
    ) => Effect.Effect<
      TailnetPreviewLaunchCapability,
      TailnetPreviewAuthCapacityError | TailnetPreviewTargetInvalidError
    >;
    readonly exchangeLaunch: (
      input: TailnetPreviewLaunchExchange,
    ) => Effect.Effect<
      TailnetPreviewGatewaySession,
      TailnetPreviewAuthCapacityError | TailnetPreviewLaunchInvalidError
    >;
    readonly validateSession: (
      input: TailnetPreviewSessionValidation,
    ) => Effect.Effect<TailnetPreviewGatewayBinding, TailnetPreviewSessionInvalidError>;
    readonly revokeLease: (leaseId: string) => Effect.Effect<void>;
  }
>()("@verne-build/cli/preview/TailnetPreviewAuth") {}

const makeWithOptions = Effect.fn("TailnetPreviewAuth.makeWithOptions")(function* (
  options?: Partial<TailnetPreviewAuthOptions>,
) {
  const config = normalizeOptions(options);
  const crypto = yield* Crypto.Crypto;
  const stateRef = yield* Ref.make<TailnetPreviewAuthState>(initialState);

  const digestHex = Effect.fn("TailnetPreviewAuth.digestHex")(function* (value: string) {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.orDie);
    return Encoding.encodeHex(digest);
  });

  const randomSecret = Effect.fn("TailnetPreviewAuth.randomSecret")(function* () {
    const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
    return Encoding.encodeBase64Url(bytes);
  });

  const mintLaunch: TailnetPreviewAuth["Service"]["mintLaunch"] = Effect.fn(
    "TailnetPreviewAuth.mintLaunch",
  )(function* (binding) {
    const target = yield* validateRelativeTarget(binding.target);
    const launchSecret = yield* randomSecret();
    const secretDigest = yield* digestHex(launchSecret);
    const now = yield* Clock.currentTimeMillis;
    const expiresAtMillis = now + config.launchTtlMs;

    const capability = yield* Ref.modify(stateRef, (state): MintLaunchDecision => {
      const nextState = pruneState(state, now);
      if (nextState.launches.size >= config.maxActiveLaunches) {
        return [
          Effect.fail(new TailnetPreviewAuthCapacityError({ resource: "launch" })),
          nextState,
        ] as const;
      }

      const launches = cloneMap(nextState.launches);
      launches.set(secretDigest, {
        environmentId: binding.environmentId,
        port: binding.port,
        leaseId: binding.leaseId,
        target,
        secretDigest,
        expiresAtMillis,
      });
      return [
        Effect.succeed({
          launchSecret,
          expiresAt: expiresAtIso(expiresAtMillis),
        }),
        { ...nextState, launches },
      ] as const;
    });

    return yield* capability;
  });

  const exchangeLaunch: TailnetPreviewAuth["Service"]["exchangeLaunch"] = Effect.fn(
    "TailnetPreviewAuth.exchangeLaunch",
  )(function* (input) {
    const launchDigest = yield* digestHex(input.launchSecret);
    const now = yield* Clock.currentTimeMillis;
    const sessionSecret = yield* randomSecret();
    const sessionDigest = yield* digestHex(sessionSecret);
    const expiresAtMillis = now + config.sessionTtlMs;

    const session = yield* Ref.modify(stateRef, (state): ExchangeLaunchDecision => {
      const nextState = pruneState(state, now);
      const revokedLaunch = [...state.revokedLaunches].find(([digest]) =>
        timingSafeDigestEqual(digest, launchDigest),
      )?.[1];
      if (revokedLaunch !== undefined && revokedLaunch.expiresAtMillis > now) {
        return [
          Effect.fail(new TailnetPreviewLaunchInvalidError({ reason: "revoked" })),
          nextState,
        ] as const;
      }

      const replayed = [...state.usedLaunches].find(([digest]) =>
        timingSafeDigestEqual(digest, launchDigest),
      )?.[1];
      if (replayed !== undefined && replayed.expiresAtMillis > now) {
        return [
          Effect.fail(new TailnetPreviewLaunchInvalidError({ reason: "replayed" })),
          nextState,
        ] as const;
      }

      const launchEntry = [...state.launches].find(([digest]) =>
        timingSafeDigestEqual(digest, launchDigest),
      );
      if (launchEntry === undefined) {
        return [
          Effect.fail(new TailnetPreviewLaunchInvalidError({ reason: "unknown" })),
          nextState,
        ] as const;
      }

      const [matchedDigest, launch] = launchEntry;
      if (launch.expiresAtMillis <= now) {
        const launches = cloneMap(nextState.launches);
        launches.delete(matchedDigest);
        return [
          Effect.fail(new TailnetPreviewLaunchInvalidError({ reason: "expired" })),
          { ...nextState, launches },
        ] as const;
      }

      if (!bindingMatches(launch, input)) {
        return [
          Effect.fail(new TailnetPreviewLaunchInvalidError({ reason: "binding-mismatch" })),
          nextState,
        ] as const;
      }

      if (nextState.sessions.size >= config.maxActiveSessions) {
        return [
          Effect.fail(new TailnetPreviewAuthCapacityError({ resource: "session" })),
          nextState,
        ] as const;
      }

      const launches = cloneMap(nextState.launches);
      launches.delete(matchedDigest);
      const usedLaunches = setBoundedEntry(
        nextState.usedLaunches,
        matchedDigest,
        {
          leaseId: launch.leaseId,
          expiresAtMillis: launch.expiresAtMillis,
        },
        config.maxUsedLaunchTombstones,
      );
      const sessions = cloneMap(nextState.sessions);
      const cookieName = cookieNameForPort(launch.port);
      sessions.set(sessionDigest, {
        environmentId: launch.environmentId,
        port: launch.port,
        leaseId: launch.leaseId,
        target: launch.target,
        cookieName,
        secretDigest: sessionDigest,
        expiresAtMillis,
      });

      return [
        Effect.succeed({
          sessionSecret,
          cookieName,
          expiresAt: expiresAtIso(expiresAtMillis),
        }),
        {
          ...nextState,
          launches,
          usedLaunches,
          sessions,
        },
      ] as const;
    });

    return yield* session;
  });

  const validateSession: TailnetPreviewAuth["Service"]["validateSession"] = Effect.fn(
    "TailnetPreviewAuth.validateSession",
  )(function* (input) {
    const sessionDigest = yield* digestHex(input.sessionSecret);
    const now = yield* Clock.currentTimeMillis;

    const binding = yield* Ref.modify(stateRef, (state): ValidateSessionDecision => {
      const nextState = pruneState(state, now);
      const revokedSession = [...state.revokedSessions].find(([digest]) =>
        timingSafeDigestEqual(digest, sessionDigest),
      )?.[1];
      if (revokedSession !== undefined && revokedSession.expiresAtMillis > now) {
        return [
          Effect.fail(new TailnetPreviewSessionInvalidError({ reason: "revoked" })),
          nextState,
        ] as const;
      }

      const sessionEntry = [...state.sessions].find(([digest]) =>
        timingSafeDigestEqual(digest, sessionDigest),
      );
      if (sessionEntry === undefined) {
        return [
          Effect.fail(new TailnetPreviewSessionInvalidError({ reason: "unknown" })),
          nextState,
        ] as const;
      }

      const [matchedDigest, session] = sessionEntry;
      if (session.expiresAtMillis <= now) {
        const sessions = cloneMap(nextState.sessions);
        sessions.delete(matchedDigest);
        return [
          Effect.fail(new TailnetPreviewSessionInvalidError({ reason: "expired" })),
          { ...nextState, sessions },
        ] as const;
      }

      if (!bindingMatches(session, input) || session.cookieName !== cookieNameForPort(input.port)) {
        return [
          Effect.fail(new TailnetPreviewSessionInvalidError({ reason: "binding-mismatch" })),
          nextState,
        ] as const;
      }

      return [
        Effect.succeed({
          environmentId: session.environmentId,
          port: session.port,
          leaseId: session.leaseId,
          target: session.target,
          cookieName: session.cookieName,
        }),
        nextState,
      ] as const;
    });

    return yield* binding;
  });

  const revokeLease: TailnetPreviewAuth["Service"]["revokeLease"] = Effect.fn(
    "TailnetPreviewAuth.revokeLease",
  )(function* (leaseId) {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(stateRef, (state) => {
      const nextState = pruneState(state, now);
      const launches = cloneMap(nextState.launches);
      const sessions = cloneMap(nextState.sessions);
      let revokedLaunches = cloneMap(nextState.revokedLaunches);
      let revokedSessions = cloneMap(nextState.revokedSessions);
      const usedLaunches = cloneMap(nextState.usedLaunches);

      for (const [digest, launch] of nextState.launches) {
        if (launch.leaseId !== leaseId) continue;
        launches.delete(digest);
        revokedLaunches = setBoundedEntry(
          revokedLaunches,
          digest,
          { leaseId, expiresAtMillis: launch.expiresAtMillis },
          config.maxRevokedLaunchTombstones,
        );
      }

      for (const [digest, used] of nextState.usedLaunches) {
        if (used.leaseId !== leaseId) continue;
        usedLaunches.delete(digest);
        revokedLaunches = setBoundedEntry(
          revokedLaunches,
          digest,
          { leaseId, expiresAtMillis: used.expiresAtMillis },
          config.maxRevokedLaunchTombstones,
        );
      }

      for (const [digest, session] of nextState.sessions) {
        if (session.leaseId !== leaseId) continue;
        sessions.delete(digest);
        revokedSessions = setBoundedEntry(
          revokedSessions,
          digest,
          { leaseId, expiresAtMillis: session.expiresAtMillis },
          config.maxRevokedSessionTombstones,
        );
      }

      return {
        ...nextState,
        launches,
        usedLaunches,
        sessions,
        revokedLaunches,
        revokedSessions,
      };
    });
  });

  const auth = TailnetPreviewAuth.of({
    mintLaunch,
    exchangeLaunch,
    validateSession,
    revokeLease,
  });

  const inspectState = Ref.get(stateRef).pipe(
    Effect.map(
      (state): TailnetPreviewAuthStateSnapshot => ({
        launches: sortedValues(state.launches),
        sessions: sortedValues(state.sessions),
        usedLaunches: sortedTombstones(state.usedLaunches),
        revokedLaunches: sortedTombstones(state.revokedLaunches),
        revokedSessions: sortedTombstones(state.revokedSessions),
      }),
    ),
  );

  return { auth, inspectState };
});

export const make = makeWithOptions().pipe(Effect.map(({ auth }) => auth));

export const layer = Layer.effect(TailnetPreviewAuth, make);

export const __testing = {
  make: makeWithOptions,
};
