import {
  PreviewTailnetLeaseNotFoundError,
  PreviewTailnetUnavailableError,
  type DiscoveredLocalServer,
  type PreviewTailnetAcquireResult,
  type PreviewTailnetStatusResult,
  type TailnetPreviewReadiness,
} from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  disableOwnedTailscaleServe,
  ensureOwnedTailscaleServe,
  readTailscaleServeConfig,
  readTailscaleStatus,
  TailscaleCommandExitError,
  TailscaleServeConflictError,
  type TailscaleCommandError,
  type TailscaleServeConfigParseError,
  type TailscaleServeMapping,
  type TailscaleServeMutationError,
  type TailscaleStatus,
  type TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PortScanner from "./PortScanner.ts";
import * as TailnetPreviewAuth from "./TailnetPreviewAuth.ts";
import {
  startTailnetPreviewGateway,
  TAILNET_PREVIEW_AUTH_PATH,
  type RunningTailnetPreviewGateway,
  type TailnetPreviewGatewayOptions,
  type TailnetPreviewGatewayStartError,
} from "./TailnetPreviewGateway.ts";

const LEASE_TTL = Duration.minutes(1);
const DISAPPEARANCE_GRACE = Duration.seconds(15);
const MAX_PUBLICATIONS = 16;

const OwnedMapping = Schema.Struct({
  servePort: Schema.Int,
  gatewayPort: Schema.Int,
  targetUrl: Schema.String,
});
type OwnedMapping = typeof OwnedMapping.Type;

const OwnedMappingRegistry = Schema.Struct({
  version: Schema.Literal(1),
  mappings: Schema.Array(OwnedMapping),
});
const encodeOwnedMappingRegistry = Schema.encodeEffect(Schema.fromJsonString(OwnedMappingRegistry));
const decodeOwnedMappingRegistry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OwnedMappingRegistry),
);

const LaunchFragment = Schema.Struct({
  launchSecret: Schema.String,
  target: Schema.String,
});
const encodeLaunchFragment = Schema.encodeSync(Schema.fromJsonString(LaunchFragment));
const isTailscaleCommandExitError = Schema.is(TailscaleCommandExitError);
const isTailscaleServeConflictError = Schema.is(TailscaleServeConflictError);

interface Lease {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly port: number;
  readonly expiresAtMillis: number;
}

interface Suppression {
  readonly threadId: string;
  readonly port: number;
}

interface Publication {
  readonly port: number;
  readonly authLeaseId: string;
  processGenerationKey: string;
  readonly scope: Scope.Closeable;
  readonly gateway: RunningTailnetPreviewGateway;
  readonly ownership: OwnedMapping;
  missingSinceMillis: number | undefined;
}

type StatusError = TailscaleCommandError | TailscaleStatusParseError;
type MappingReadError = TailscaleCommandError | TailscaleServeConfigParseError;

export class TailnetPreviewTailscale extends Context.Service<
  TailnetPreviewTailscale,
  {
    readonly readStatus: Effect.Effect<TailscaleStatus, StatusError>;
    readonly readMappings: Effect.Effect<
      ReadonlyMap<number, TailscaleServeMapping>,
      MappingReadError
    >;
    readonly ensureOwned: (input: {
      readonly servePort: number;
      readonly localHost: string;
      readonly localPort: number;
    }) => Effect.Effect<"created" | "existing", TailscaleServeMutationError>;
    readonly disableOwned: (input: {
      readonly servePort: number;
      readonly localHost: string;
      readonly localPort: number;
    }) => Effect.Effect<"removed" | "absent", TailscaleServeMutationError>;
  }
>()("@verne-build/cli/preview/TailnetPreviewPublisher/TailnetPreviewTailscale") {
  static readonly layer = Layer.effect(
    TailnetPreviewTailscale,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const platform = yield* HostProcessPlatform;
      return TailnetPreviewTailscale.of({
        readStatus: readTailscaleStatus.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, platform),
        ),
        readMappings: readTailscaleServeConfig.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, platform),
        ),
        ensureOwned: (input) =>
          ensureOwnedTailscaleServe(input).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcessPlatform, platform),
          ),
        disableOwned: (input) =>
          disableOwnedTailscaleServe(input).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcessPlatform, platform),
          ),
      });
    }),
  );
}

export class TailnetPreviewGatewayFactory extends Context.Service<
  TailnetPreviewGatewayFactory,
  {
    readonly start: (
      options: TailnetPreviewGatewayOptions,
    ) => Effect.Effect<RunningTailnetPreviewGateway, TailnetPreviewGatewayStartError>;
  }
>()("@verne-build/cli/preview/TailnetPreviewPublisher/TailnetPreviewGatewayFactory") {
  static readonly layer = Layer.succeed(
    TailnetPreviewGatewayFactory,
    TailnetPreviewGatewayFactory.of({ start: startTailnetPreviewGateway }),
  );
}

export interface TailnetPreviewPublisherOptions {
  readonly environmentId: string;
  readonly leaseTtl?: Duration.Input;
  readonly disappearanceGrace?: Duration.Input;
  readonly maxPublications?: number;
}

type AcquireInput = {
  readonly sessionId: string;
  readonly threadId: string;
  readonly port: number;
};

type ReleaseInput = {
  readonly sessionId: string;
  readonly leaseId: string;
};

export class TailnetPreviewPublisher extends Context.Service<
  TailnetPreviewPublisher,
  {
    readonly status: () => Effect.Effect<PreviewTailnetStatusResult>;
    readonly acquire: (
      input: AcquireInput,
    ) => Effect.Effect<PreviewTailnetAcquireResult, PreviewTailnetUnavailableError>;
    readonly renew: (
      input: AcquireInput,
    ) => Effect.Effect<
      PreviewTailnetAcquireResult,
      PreviewTailnetLeaseNotFoundError | PreviewTailnetUnavailableError
    >;
    readonly release: (
      input: ReleaseInput,
    ) => Effect.Effect<void, PreviewTailnetLeaseNotFoundError>;
    readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
    readonly setPortEnabled: (input: {
      readonly threadId: string;
      readonly port: number;
      readonly enabled: boolean;
    }) => Effect.Effect<PreviewTailnetStatusResult, PreviewTailnetUnavailableError>;
    readonly refreshSettings: () => Effect.Effect<void>;
    readonly reconcileStartup: () => Effect.Effect<{ readonly conflicts: ReadonlyArray<number> }>;
  }
>()("@verne-build/cli/preview/TailnetPreviewPublisher") {}

const readinessFromTailscaleError = (
  error: unknown,
  phase: "status" | "serve",
): Exclude<
  TailnetPreviewReadiness,
  "disabled" | "ready" | "magic-dns-unavailable" | "gateway-failed" | "capacity-reached"
> => {
  if (isTailscaleServeConflictError(error)) return "mapping-conflict";
  if (isTailscaleCommandExitError(error)) {
    if (error.stderrDiagnostic === "not-logged-in") return "not-logged-in";
    if (error.stderrDiagnostic === "permission-denied") return "permission-denied";
  }
  return phase === "serve" ? "https-unavailable" : "tailscale-unavailable";
};

const processGenerationKey = (server: DiscoveredLocalServer): string =>
  JSON.stringify([
    server.port,
    server.pid,
    server.terminal?.threadId ?? null,
    server.terminal?.terminalId ?? null,
    server.connectHost ?? null,
  ]);

const relativeTarget = (server: DiscoveredLocalServer): string => {
  try {
    const url = new URL(server.url);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
};

const mappingInput = (mapping: OwnedMapping) => ({
  servePort: mapping.servePort,
  localHost: "127.0.0.1",
  localPort: mapping.gatewayPort,
});

const mappingMatches = (mapping: TailscaleServeMapping | undefined, owned: OwnedMapping) =>
  mapping?.proxyUrl === owned.targetUrl;

const sortOwnedMappings = (mappings: Iterable<OwnedMapping>): ReadonlyArray<OwnedMapping> =>
  [...mappings].sort((left, right) => left.servePort - right.servePort);

export const make = Effect.fn("TailnetPreviewPublisher.make")(function* (
  options: TailnetPreviewPublisherOptions,
) {
  const discovery = yield* PortScanner.PortDiscovery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const auth = yield* TailnetPreviewAuth.TailnetPreviewAuth;
  const tailscale = yield* TailnetPreviewTailscale;
  const gatewayFactory = yield* TailnetPreviewGatewayFactory;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);
  const workerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const leaseTtlMs = Duration.toMillis(options.leaseTtl ?? LEASE_TTL);
  const disappearanceGrace = options.disappearanceGrace ?? DISAPPEARANCE_GRACE;
  const maxPublications = options.maxPublications ?? MAX_PUBLICATIONS;

  const publications = new Map<number, Publication>();
  const leases = new Map<string, Lease>();
  const suppressions = new Map<string, Suppression>();
  const ownership = new Map<number, OwnedMapping>();
  let discoveredServers = yield* discovery.scan();

  const withMutation = <A, E, R>(effect: Effect.Effect<A, E, R>) => mutex.withPermits(1)(effect);

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.tailscalePreviewsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const persistOwnership = Effect.fn("TailnetPreviewPublisher.persistOwnership")(function* () {
    const contents = yield* encodeOwnedMappingRegistry({
      version: 1,
      mappings: [...sortOwnedMappings(ownership.values())],
    }).pipe(Effect.orDie);
    yield* writeFileStringAtomically({
      filePath: config.tailnetPreviewMappingsPath,
      contents: `${contents}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  });

  const readOwnership = Effect.fn("TailnetPreviewPublisher.readOwnership")(function* () {
    const exists = yield* fs
      .exists(config.tailnetPreviewMappingsPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [] as ReadonlyArray<OwnedMapping>;
    return yield* fs.readFileString(config.tailnetPreviewMappingsPath).pipe(
      Effect.flatMap(decodeOwnedMappingRegistry),
      Effect.map((registry) => registry.mappings),
      Effect.orElseSucceed(() => [] as ReadonlyArray<OwnedMapping>),
    );
  });

  const teardownPublication = Effect.fn("TailnetPreviewPublisher.teardownPublication")(function* (
    publication: Publication,
  ) {
    publications.delete(publication.port);
    for (const [leaseId, lease] of leases) {
      if (lease.port === publication.port) leases.delete(leaseId);
    }
    yield* auth.revokeLease(publication.authLeaseId);
    const removed = yield* Effect.result(
      tailscale.disableOwned(mappingInput(publication.ownership)),
    );
    if (Result.isSuccess(removed)) {
      ownership.delete(publication.port);
      yield* persistOwnership().pipe(Effect.ignoreCause({ log: true }));
    } else {
      yield* Effect.logWarning("Tailnet preview mapping cleanup was left for reconciliation.", {
        port: publication.port,
        readiness: readinessFromTailscaleError(removed.failure, "serve"),
      });
    }
    yield* Scope.close(publication.scope, Exit.void).pipe(Effect.ignore);
  });

  const scheduleLeaseExpiry = (lease: Lease) =>
    Effect.sleep(Duration.millis(leaseTtlMs)).pipe(
      Effect.andThen(
        withMutation(
          Effect.gen(function* () {
            const current = leases.get(lease.leaseId);
            const now = yield* Clock.currentTimeMillis;
            if (
              current?.expiresAtMillis !== lease.expiresAtMillis ||
              current.expiresAtMillis > now
            ) {
              return;
            }
            leases.delete(lease.leaseId);
            const publication = publications.get(lease.port);
            if (
              publication !== undefined &&
              ![...leases.values()].some((candidate) => candidate.port === lease.port)
            ) {
              yield* teardownPublication(publication);
            }
          }),
        ),
      ),
      Effect.forkIn(workerScope),
      Effect.asVoid,
    );

  const updateDiscovery = Effect.fn("TailnetPreviewPublisher.updateDiscovery")(function* (
    next: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    discoveredServers = next;
    const currentGenerations = new Map(
      next.map((server) => [
        `${server.terminal?.threadId ?? ""}:${server.port}`,
        processGenerationKey(server),
      ]),
    );
    for (const [key, suppression] of suppressions) {
      const current = currentGenerations.get(`${suppression.threadId}:${suppression.port}`);
      if (current !== undefined && current !== key) suppressions.delete(key);
    }

    const now = yield* Clock.currentTimeMillis;
    for (const publication of publications.values()) {
      const leaseThreads = new Set(
        [...leases.values()]
          .filter((lease) => lease.port === publication.port)
          .map((lease) => lease.threadId),
      );
      const present = next.find(
        (server) =>
          server.port === publication.port &&
          server.terminal !== null &&
          leaseThreads.has(server.terminal.threadId),
      );
      if (present !== undefined) {
        publication.processGenerationKey = processGenerationKey(present);
        publication.missingSinceMillis = undefined;
        continue;
      }
      if (publication.missingSinceMillis !== undefined) continue;
      publication.missingSinceMillis = now;
      const missingSince = now;
      yield* Effect.sleep(disappearanceGrace).pipe(
        Effect.andThen(
          withMutation(
            Effect.gen(function* () {
              const current = publications.get(publication.port);
              if (current?.missingSinceMillis !== missingSince) return;
              yield* teardownPublication(current);
            }),
          ),
        ),
        Effect.forkIn(workerScope),
      );
    }
  });

  const currentServer = Effect.fn("TailnetPreviewPublisher.currentServer")(function* (
    threadId: string,
    port: number,
  ) {
    const scanned = yield* discovery.scan();
    yield* updateDiscovery(scanned);
    return scanned.find(
      (server) =>
        server.port === port &&
        server.terminal?.threadId === threadId &&
        server.connectHost !== undefined,
    );
  });

  const status: TailnetPreviewPublisher["Service"]["status"] = Effect.fn(
    "TailnetPreviewPublisher.status",
  )(function* () {
    if (!(yield* enabled)) return { enabled: false, readiness: "disabled" };
    const tailscaleStatus = yield* Effect.result(tailscale.readStatus);
    if (Result.isFailure(tailscaleStatus)) {
      return {
        enabled: true,
        readiness: readinessFromTailscaleError(tailscaleStatus.failure, "status"),
      };
    }
    return {
      enabled: true,
      readiness: tailscaleStatus.success.magicDnsName === null ? "magic-dns-unavailable" : "ready",
    };
  });

  const requireReady = Effect.fn("TailnetPreviewPublisher.requireReady")(function* (port: number) {
    if (!(yield* enabled)) {
      return yield* new PreviewTailnetUnavailableError({ port, readiness: "disabled" });
    }
    const tailscaleStatus = yield* tailscale.readStatus.pipe(
      Effect.mapError(
        (error) =>
          new PreviewTailnetUnavailableError({
            port,
            readiness: readinessFromTailscaleError(error, "status"),
          }),
      ),
    );
    if (tailscaleStatus.magicDnsName === null) {
      return yield* new PreviewTailnetUnavailableError({
        port,
        readiness: "magic-dns-unavailable",
      });
    }
    return tailscaleStatus.magicDnsName;
  });

  const makeResult = Effect.fn("TailnetPreviewPublisher.makeResult")(function* (
    lease: Lease,
    publication: Publication,
    server: DiscoveredLocalServer,
    magicDnsName: string,
  ) {
    const target = relativeTarget(server);
    const launch = yield* auth
      .mintLaunch({
        environmentId: options.environmentId,
        port: lease.port,
        leaseId: publication.authLeaseId,
        target,
      })
      .pipe(
        Effect.mapError(
          () =>
            new PreviewTailnetUnavailableError({ port: lease.port, readiness: "gateway-failed" }),
        ),
      );
    const baseUrl = buildTailscaleHttpsBaseUrl({ magicDnsName, servePort: lease.port });
    const cleanUrl = new URL(target, baseUrl).toString();
    const launchUrl = new URL(TAILNET_PREVIEW_AUTH_PATH, baseUrl);
    launchUrl.hash = encodeURIComponent(
      encodeLaunchFragment({ launchSecret: launch.launchSecret, target }),
    );
    return {
      leaseId: lease.leaseId,
      port: lease.port,
      cleanUrl,
      launchUrl: launchUrl.toString(),
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(lease.expiresAtMillis)),
      readiness: "ready" as const,
    };
  });

  const acquire = Effect.fn("TailnetPreviewPublisher.acquire")(function* (input: AcquireInput) {
    return yield* withMutation(
      Effect.gen(function* () {
        const magicDnsName = yield* requireReady(input.port);
        const server = yield* currentServer(input.threadId, input.port);
        if (server === undefined) {
          return yield* new PreviewTailnetUnavailableError({
            port: input.port,
            readiness: "gateway-failed",
          });
        }
        const generationKey = processGenerationKey(server);
        if (suppressions.has(generationKey)) {
          return yield* new PreviewTailnetUnavailableError({
            port: input.port,
            readiness: "disabled",
          });
        }

        const now = yield* Clock.currentTimeMillis;
        const existingLease = [...leases.values()].find(
          (lease) =>
            lease.sessionId === input.sessionId &&
            lease.threadId === input.threadId &&
            lease.port === input.port,
        );
        const existingPublication = publications.get(input.port);
        if (existingLease !== undefined && existingPublication !== undefined) {
          const renewed = { ...existingLease, expiresAtMillis: now + leaseTtlMs };
          leases.set(renewed.leaseId, renewed);
          yield* scheduleLeaseExpiry(renewed);
          return yield* makeResult(renewed, existingPublication, server, magicDnsName);
        }

        let publication = existingPublication;
        if (publication === undefined) {
          if (publications.size >= maxPublications) {
            return yield* new PreviewTailnetUnavailableError({
              port: input.port,
              readiness: "capacity-reached",
            });
          }
          const publicationScope = yield* Scope.make();
          const authLeaseId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const gateway = yield* Effect.acquireRelease(
            gatewayFactory.start({
              auth,
              environmentId: options.environmentId,
              leaseId: authLeaseId,
              target: { host: server.connectHost!, port: input.port },
            }),
            (running) => running.close,
          ).pipe(
            Effect.provideService(Scope.Scope, publicationScope),
            Effect.onError(() => Scope.close(publicationScope, Exit.void).pipe(Effect.ignore)),
            Effect.mapError(
              () =>
                new PreviewTailnetUnavailableError({
                  port: input.port,
                  readiness: "gateway-failed",
                }),
            ),
          );
          const owned: OwnedMapping = {
            servePort: input.port,
            gatewayPort: gateway.gatewayPort,
            targetUrl: `http://127.0.0.1:${gateway.gatewayPort}`,
          };
          const mapping = yield* Effect.result(tailscale.ensureOwned(mappingInput(owned)));
          if (Result.isFailure(mapping)) {
            yield* Scope.close(publicationScope, Exit.void).pipe(Effect.ignore);
            return yield* new PreviewTailnetUnavailableError({
              port: input.port,
              readiness: readinessFromTailscaleError(mapping.failure, "serve"),
            });
          }
          ownership.set(input.port, owned);
          const persisted = yield* Effect.exit(persistOwnership());
          if (persisted._tag === "Failure") {
            ownership.delete(input.port);
            yield* tailscale.disableOwned(mappingInput(owned)).pipe(Effect.ignore);
            yield* Scope.close(publicationScope, Exit.void).pipe(Effect.ignore);
            return yield* new PreviewTailnetUnavailableError({
              port: input.port,
              readiness: "gateway-failed",
            });
          }
          publication = {
            port: input.port,
            authLeaseId,
            processGenerationKey: generationKey,
            scope: publicationScope,
            gateway,
            ownership: owned,
            missingSinceMillis: undefined,
          };
          publications.set(input.port, publication);
        }

        const leaseId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const lease: Lease = {
          leaseId,
          sessionId: input.sessionId,
          threadId: input.threadId,
          port: input.port,
          expiresAtMillis: now + leaseTtlMs,
        };
        leases.set(leaseId, lease);
        yield* scheduleLeaseExpiry(lease);
        return yield* makeResult(lease, publication, server, magicDnsName);
      }),
    );
  });

  const renew: TailnetPreviewPublisher["Service"]["renew"] = Effect.fn(
    "TailnetPreviewPublisher.renew",
  )(function* (input) {
    const exists = yield* withMutation(
      Effect.sync(() =>
        [...leases.values()].some(
          (lease) =>
            lease.sessionId === input.sessionId &&
            lease.threadId === input.threadId &&
            lease.port === input.port,
        ),
      ),
    );
    if (!exists) {
      return yield* new PreviewTailnetLeaseNotFoundError({
        leaseId: `${input.threadId}:${input.port}`,
      });
    }
    return yield* acquire(input);
  });

  const release: TailnetPreviewPublisher["Service"]["release"] = Effect.fn(
    "TailnetPreviewPublisher.release",
  )(function* (input) {
    yield* withMutation(
      Effect.gen(function* () {
        const lease = leases.get(input.leaseId);
        if (lease?.sessionId !== input.sessionId) {
          return yield* new PreviewTailnetLeaseNotFoundError({ leaseId: input.leaseId });
        }
        leases.delete(input.leaseId);
        const publication = publications.get(lease.port);
        if (
          publication !== undefined &&
          ![...leases.values()].some((candidate) => candidate.port === lease.port)
        ) {
          yield* teardownPublication(publication);
        }
      }),
    );
  });

  const releaseSession: TailnetPreviewPublisher["Service"]["releaseSession"] = Effect.fn(
    "TailnetPreviewPublisher.releaseSession",
  )(function* (sessionId) {
    yield* withMutation(
      Effect.gen(function* () {
        const affectedPorts = new Set<number>();
        for (const [leaseId, lease] of leases) {
          if (lease.sessionId !== sessionId) continue;
          affectedPorts.add(lease.port);
          leases.delete(leaseId);
        }
        for (const port of affectedPorts) {
          const publication = publications.get(port);
          if (
            publication !== undefined &&
            ![...leases.values()].some((candidate) => candidate.port === port)
          ) {
            yield* teardownPublication(publication);
          }
        }
      }),
    );
  });

  const setPortEnabled: TailnetPreviewPublisher["Service"]["setPortEnabled"] = Effect.fn(
    "TailnetPreviewPublisher.setPortEnabled",
  )(function* (input) {
    return yield* withMutation(
      Effect.gen(function* () {
        const server = yield* currentServer(input.threadId, input.port);
        if (server === undefined) {
          return yield* new PreviewTailnetUnavailableError({
            port: input.port,
            readiness: "gateway-failed",
          });
        }
        const generationKey = processGenerationKey(server);
        if (input.enabled) {
          suppressions.delete(generationKey);
        } else {
          suppressions.set(generationKey, { threadId: input.threadId, port: input.port });
          const publication = publications.get(input.port);
          if (publication !== undefined) yield* teardownPublication(publication);
        }
        return yield* status();
      }),
    );
  });

  const refreshSettings: TailnetPreviewPublisher["Service"]["refreshSettings"] = Effect.fn(
    "TailnetPreviewPublisher.refreshSettings",
  )(function* () {
    if (yield* enabled) return;
    yield* withMutation(
      Effect.forEach([...publications.values()], teardownPublication, { discard: true }),
    );
  });

  const reconcileStartup: TailnetPreviewPublisher["Service"]["reconcileStartup"] = Effect.fn(
    "TailnetPreviewPublisher.reconcileStartup",
  )(function* () {
    return yield* withMutation(
      Effect.gen(function* () {
        ownership.clear();
        for (const record of yield* readOwnership()) ownership.set(record.servePort, record);
        if (ownership.size === 0) return { conflicts: [] };
        const currentResult = yield* Effect.result(tailscale.readMappings);
        if (Result.isFailure(currentResult)) {
          return { conflicts: [...ownership.keys()].sort((left, right) => left - right) };
        }
        const current = currentResult.success;
        const conflicts: number[] = [];
        for (const record of ownership.values()) {
          const actual = current.get(record.servePort);
          if (actual === undefined) {
            ownership.delete(record.servePort);
            continue;
          }
          if (!mappingMatches(actual, record)) {
            conflicts.push(record.servePort);
            continue;
          }
          if (publications.get(record.servePort)?.ownership.targetUrl === record.targetUrl)
            continue;
          const result = yield* Effect.result(tailscale.disableOwned(mappingInput(record)));
          if (Result.isSuccess(result)) ownership.delete(record.servePort);
          else conflicts.push(record.servePort);
        }
        yield* persistOwnership().pipe(Effect.ignoreCause({ log: true }));
        return { conflicts: conflicts.sort((left, right) => left - right) };
      }),
    );
  });

  yield* discovery.retain;
  yield* discovery.subscribe(
    { configuredUrls: [], initialSnapshot: discoveredServers },
    (servers) => withMutation(updateDiscovery(servers)),
  );

  return TailnetPreviewPublisher.of({
    status,
    acquire,
    renew,
    release,
    releaseSession,
    setPortEnabled,
    refreshSettings,
    reconcileStartup,
  });
});

export const layer = (options: TailnetPreviewPublisherOptions) =>
  Layer.effect(TailnetPreviewPublisher, make(options)).pipe(
    Layer.provide(TailnetPreviewGatewayFactory.layer),
    Layer.provide(TailnetPreviewTailscale.layer),
  );

export const __testing = { readinessFromTailscaleError, processGenerationKey };
