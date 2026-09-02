import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type DiscoveredLocalServer,
  PreviewTailnetLeaseNotFoundError,
} from "@t3tools/contracts";
import {
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleServeConflictError,
} from "@t3tools/tailscale";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PortScanner from "./PortScanner.ts";
import * as TailnetPreviewAuth from "./TailnetPreviewAuth.ts";
import { TailnetPreviewGatewayStartError } from "./TailnetPreviewGateway.ts";
import * as TailnetPreviewPublisher from "./TailnetPreviewPublisher.ts";

const TestOwnedMappingRegistry = Schema.Struct({
  version: Schema.Literal(1),
  mappings: Schema.Array(
    Schema.Struct({
      servePort: Schema.Int,
      gatewayPort: Schema.Int,
      targetUrl: Schema.String,
    }),
  ),
});
const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(TestOwnedMappingRegistry));
const encodeRegistry = Schema.encodeEffect(Schema.fromJsonString(TestOwnedMappingRegistry));

const server = (
  port: number,
  overrides: Partial<DiscoveredLocalServer> = {},
): DiscoveredLocalServer => ({
  host: "localhost",
  connectHost: "127.0.0.1",
  port,
  url: `http://localhost:${port}/`,
  processName: "node",
  pid: 1_000 + port,
  terminal: { threadId: ThreadId.make("thread-a"), terminalId: "terminal-a" },
  ...overrides,
});

const spawnFailure = () =>
  new TailscaleCommandSpawnError({
    executable: "tailscale",
    subcommand: "status",
    argumentCount: 2,
    cause: new Error("ENOENT secret-that-must-not-surface"),
  });

const exitFailure = (
  subcommand: "status" | "serve",
  stderrDiagnostic: "not-logged-in" | "permission-denied" | "unknown",
) =>
  new TailscaleCommandExitError({
    executable: "tailscale",
    subcommand,
    argumentCount: 2,
    exitCode: 1,
    stdoutLength: 0,
    stderrLength: 100,
    stderrDiagnostic,
  });

let randomByte = 0;
const testCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill((randomByte += 1)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const makeHarness = Effect.fn("TailnetPreviewPublisherTest.makeHarness")(function* (input?: {
  readonly enabled?: boolean;
  readonly servers?: ReadonlyArray<DiscoveredLocalServer>;
  readonly maxPublications?: number;
  readonly leaseTtl?: Duration.Input;
}) {
  const initialServers = input?.servers ?? [server(5173)];
  const discoveredRef = yield* Ref.make(initialServers);
  let nextGeneration = 0;
  const generationsRef = yield* Ref.make(
    new Map(
      initialServers.map((candidate) => [
        candidate.port,
        { pid: candidate.pid, value: `generation-${(nextGeneration += 1)}` },
      ]),
    ),
  );
  const discoveryCallsRef = yield* Ref.make(0);
  const discoveryRetainsRef = yield* Ref.make(0);
  const discoveryListenerRef = yield* Ref.make<
    ((servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>) | undefined
  >(undefined);
  const settingsRef = yield* Ref.make({
    ...DEFAULT_SERVER_SETTINGS,
    tailscalePreviewsEnabled: input?.enabled ?? true,
  });
  const tailscaleCallsRef = yield* Ref.make(0);
  const tailscaleStatusRef = yield* Ref.make<
    | { readonly magicDnsName: string | null; readonly tailnetIpv4Addresses: readonly string[] }
    | Error
  >({ magicDnsName: "machine.tail.ts.net", tailnetIpv4Addresses: ["100.64.0.1"] });
  const ensureFailureRef = yield* Ref.make<Error | undefined>(undefined);
  const disableFailureRef = yield* Ref.make<Error | undefined>(undefined);
  const mintFailureRef = yield* Ref.make(false);
  const blockMintRef = yield* Ref.make(false);
  const mintEntered = yield* Deferred.make<void>();
  const continueMint = yield* Deferred.make<void>();
  const gatewayFailureRef = yield* Ref.make(false);
  const registryWriteFailuresRef = yield* Ref.make(0);
  const mappingsRef = yield* Ref.make<ReadonlyMap<number, { servePort: number; proxyUrl: string }>>(
    new Map(),
  );
  const startsRef = yield* Ref.make<ReadonlyArray<{ host: string; port: number }>>([]);
  const closesRef = yield* Ref.make<ReadonlyArray<number>>([]);
  const closeSignal = yield* Deferred.make<void>();
  const revokesRef = yield* Ref.make<ReadonlyArray<string>>([]);
  const realAuth = yield* TailnetPreviewAuth.TailnetPreviewAuth;
  const realFileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;

  const discovery = PortScanner.PortDiscovery.of({
    scan: () =>
      Ref.update(discoveryCallsRef, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(discoveredRef)),
      ),
    processGeneration: (candidate) =>
      Ref.get(generationsRef).pipe(
        Effect.map((generations) => {
          const generation = generations.get(candidate.port);
          return generation?.pid === candidate.pid ? generation.value : undefined;
        }),
      ),
    subscribe: (_input, listener) =>
      Effect.acquireRelease(Ref.set(discoveryListenerRef, listener), () =>
        Ref.set(discoveryListenerRef, undefined),
      ),
    retain: Effect.acquireRelease(
      Ref.update(discoveryRetainsRef, (count) => count + 1),
      () => Ref.update(discoveryRetainsRef, (count) => count - 1),
    ),
    registerTerminalProcesses: () => Effect.void,
    unregisterTerminal: () => Effect.void,
  });
  const auth = TailnetPreviewAuth.TailnetPreviewAuth.of({
    ...realAuth,
    mintLaunch: (binding) =>
      Effect.gen(function* () {
        if (yield* Ref.get(mintFailureRef)) {
          return yield* new TailnetPreviewAuth.TailnetPreviewAuthCapacityError({
            resource: "launch",
          });
        }
        if (yield* Ref.get(blockMintRef)) {
          yield* Deferred.succeed(mintEntered, undefined);
          yield* Deferred.await(continueMint);
        }
        return yield* realAuth.mintLaunch(binding);
      }),
    revokeLease: (leaseId) =>
      Ref.update(revokesRef, (revokes) => [...revokes, leaseId]).pipe(
        Effect.andThen(realAuth.revokeLease(leaseId)),
      ),
  });
  const fileSystem = FileSystem.FileSystem.of({
    ...realFileSystem,
    rename: (oldPath, newPath) =>
      Ref.modify(registryWriteFailuresRef, (remaining) => [
        remaining > 0,
        Math.max(0, remaining - 1),
      ]).pipe(
        Effect.flatMap((fail) =>
          fail && newPath === config.tailnetPreviewMappingsPath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: newPath,
                }),
              )
            : realFileSystem.rename(oldPath, newPath),
        ),
      ),
  });
  const settings = ServerSettings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settingsRef),
    updateSettings: (patch) =>
      Ref.updateAndGet(settingsRef, (current) => ({ ...current, ...patch }) as never),
    streamChanges: Effect.die("unused") as never,
    subscribeChanges: Effect.die("unused") as never,
  });
  const tailscale = TailnetPreviewPublisher.TailnetPreviewTailscale.of({
    readStatus: Ref.update(tailscaleCallsRef, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(tailscaleStatusRef)),
      Effect.flatMap((value) =>
        value instanceof Error ? Effect.fail(value as never) : Effect.succeed(value),
      ),
    ),
    readMappings: Ref.get(mappingsRef),
    ensureOwned: (mapping) =>
      Ref.get(ensureFailureRef).pipe(
        Effect.flatMap((failure) =>
          failure === undefined
            ? Ref.update(mappingsRef, (current) => {
                const next = new Map(current);
                next.set(mapping.servePort, {
                  servePort: mapping.servePort,
                  proxyUrl: `http://127.0.0.1:${mapping.localPort}`,
                });
                return next;
              }).pipe(Effect.as("created" as const))
            : Effect.fail(failure as never),
        ),
      ),
    disableOwned: (mapping) =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(disableFailureRef);
        if (failure !== undefined) return yield* Effect.fail(failure as never);
        const current = yield* Ref.get(mappingsRef);
        const expected = `http://127.0.0.1:${mapping.localPort}`;
        if (current.get(mapping.servePort)?.proxyUrl !== expected) {
          return yield* new TailscaleServeConflictError({ servePort: mapping.servePort });
        }
        const next = new Map(current);
        next.delete(mapping.servePort);
        yield* Ref.set(mappingsRef, next);
        return "removed" as const;
      }),
  });
  const gatewayFactory = TailnetPreviewPublisher.TailnetPreviewGatewayFactory.of({
    start: (options) =>
      Ref.get(gatewayFailureRef).pipe(
        Effect.flatMap((fail) =>
          fail
            ? Effect.fail(new TailnetPreviewGatewayStartError(new Error("test gateway failure")))
            : Ref.modify(startsRef, (starts) => {
                const gatewayPort = 43_000 + starts.length;
                return [
                  {
                    gatewayPort,
                    target: options.target,
                    close: Ref.update(closesRef, (closed) => [...closed, gatewayPort]).pipe(
                      Effect.andThen(Deferred.succeed(closeSignal, undefined)),
                      Effect.asVoid,
                    ),
                  },
                  [...starts, options.target],
                ] as const;
              }),
        ),
      ),
  });

  const publisherScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(publisherScope, Exit.void));
  const publisher = yield* TailnetPreviewPublisher.make({
    environmentId: "environment-a",
    ...(input?.maxPublications === undefined ? {} : { maxPublications: input.maxPublications }),
    ...(input?.leaseTtl === undefined ? {} : { leaseTtl: input.leaseTtl }),
  }).pipe(
    Effect.provideService(PortScanner.PortDiscovery, discovery),
    Effect.provideService(ServerSettings.ServerSettingsService, settings),
    Effect.provideService(TailnetPreviewAuth.TailnetPreviewAuth, auth),
    Effect.provideService(TailnetPreviewPublisher.TailnetPreviewTailscale, tailscale),
    Effect.provideService(TailnetPreviewPublisher.TailnetPreviewGatewayFactory, gatewayFactory),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Scope.Scope, publisherScope),
  );

  const pushDiscovery = Effect.fn("TailnetPreviewPublisherTest.pushDiscovery")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const previousServers = yield* Ref.get(discoveredRef);
    yield* Ref.update(generationsRef, (current) => {
      const next = new Map<number, { readonly pid: number | null; readonly value: string }>();
      for (const candidate of servers) {
        const previousServer = previousServers.find((entry) => entry.port === candidate.port);
        const previous = current.get(candidate.port);
        next.set(
          candidate.port,
          previousServer?.pid === candidate.pid && previous !== undefined
            ? previous
            : { pid: candidate.pid, value: `generation-${(nextGeneration += 1)}` },
        );
      }
      return next;
    });
    yield* Ref.set(discoveredRef, servers);
    const listener = yield* Ref.get(discoveryListenerRef);
    if (listener === undefined) return yield* Effect.die("discovery listener not retained");
    yield* listener(servers);
  });

  return {
    publisher,
    closePublisher: Scope.close(publisherScope, Exit.void),
    settings,
    pushDiscovery,
    tailscaleCallsRef,
    discoveryCallsRef,
    discoveryRetainsRef,
    tailscaleStatusRef,
    ensureFailureRef,
    disableFailureRef,
    mintFailureRef,
    blockMintRef,
    mintEntered,
    continueMint,
    gatewayFailureRef,
    registryWriteFailuresRef,
    mappingsRef,
    startsRef,
    closesRef,
    closeSignal,
    revokesRef,
  };
});

const layer = Layer.mergeAll(
  NodeServices.layer,
  testCryptoLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "tailnet-preview-publisher-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  TailnetPreviewAuth.layer.pipe(Layer.provide(testCryptoLayer)),
);

effectIt.effect("reports disabled without invoking Tailscale", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ enabled: false });
    expect(yield* harness.publisher.status()).toEqual({ enabled: false, readiness: "disabled" });
    expect(yield* Ref.get(harness.tailscaleCallsRef)).toBe(0);
    expect(yield* Ref.get(harness.discoveryCallsRef)).toBe(0);
    expect(yield* Ref.get(harness.discoveryRetainsRef)).toBe(0);
    yield* harness.settings.updateSettings({ tailscalePreviewsEnabled: true });
    yield* harness.publisher.refreshSettings();
    expect(yield* Ref.get(harness.discoveryCallsRef)).toBe(1);
    expect(yield* Ref.get(harness.discoveryRetainsRef)).toBe(1);
    yield* harness.settings.updateSettings({ tailscalePreviewsEnabled: false });
    yield* harness.publisher.refreshSettings();
    expect(yield* Ref.get(harness.discoveryRetainsRef)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("rejects undiscovered and wrong-thread ports before starting a gateway", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const undiscovered = yield* Effect.flip(
      harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 9000 }),
    );
    const wrongThread = yield* Effect.flip(
      harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-b", port: 5173 }),
    );
    expect(undiscovered).toMatchObject({ _tag: "PreviewTailnetUnavailableError", port: 9000 });
    expect(wrongThread).toMatchObject({ _tag: "PreviewTailnetUnavailableError", port: 5173 });
    expect(yield* Ref.get(harness.startsRef)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("uses only the scanner-normalized connect host", () =>
  Effect.gen(function* () {
    const cases = [
      { host: "localhost", connectHost: "127.0.0.1" },
      { host: "127.0.0.1", connectHost: "127.0.0.1" },
      { host: "::1", connectHost: "::1" },
      { host: "0.0.0.0", connectHost: "127.0.0.1" },
    ] as const;
    for (const [index, { host, connectHost }] of cases.entries()) {
      const port = 5_173 + index;
      const harness = yield* makeHarness({ servers: [server(port, { host, connectHost })] });
      yield* harness.publisher.acquire({
        sessionId: `session-${index}`,
        threadId: "thread-a",
        port,
      });
      expect((yield* Ref.get(harness.startsRef))[0]).toEqual({ host: connectHost, port });
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("shares one publication while leases stay session-idempotent", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const first = yield* harness.publisher.acquire({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    const duplicate = yield* harness.publisher.acquire({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    const second = yield* harness.publisher.acquire({
      sessionId: "session-b",
      threadId: "thread-a",
      port: 5173,
    });
    expect(duplicate.leaseId).toBe(first.leaseId);
    expect(second.leaseId).not.toBe(first.leaseId);
    expect(yield* Ref.get(harness.startsRef)).toHaveLength(1);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(1);

    yield* TestClock.adjust(Duration.seconds(1));
    const renewed = yield* harness.publisher.renew({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    expect(renewed.leaseId).toBe(first.leaseId);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));

    yield* harness.publisher.release({ sessionId: "session-a", leaseId: first.leaseId });
    expect(yield* Ref.get(harness.closesRef)).toEqual([]);
    yield* harness.publisher.release({ sessionId: "session-b", leaseId: second.leaseId });
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("serializes concurrent acquire and release without duplicate publications", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const [first, second] = yield* Effect.all(
      [
        harness.publisher.acquire({
          sessionId: "session-a",
          threadId: "thread-a",
          port: 5173,
        }),
        harness.publisher.acquire({
          sessionId: "session-b",
          threadId: "thread-a",
          port: 5173,
        }),
      ],
      { concurrency: "unbounded" },
    );
    expect(yield* Ref.get(harness.startsRef)).toHaveLength(1);

    yield* Effect.all(
      [
        harness.publisher.release({ sessionId: "session-a", leaseId: first.leaseId }),
        harness.publisher.release({ sessionId: "session-b", leaseId: second.leaseId }),
      ],
      { concurrency: "unbounded", discard: true },
    );
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("does not let concurrent renew resurrect a released session", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });

    yield* Ref.set(harness.blockMintRef, true);
    const lockHolder = yield* Effect.forkChild(
      harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
    );
    yield* Deferred.await(harness.mintEntered);
    const renew = yield* Effect.forkChild(
      harness.publisher
        .renew({ sessionId: "session-a", threadId: "thread-a", port: 5173 })
        .pipe(Effect.result),
    );
    yield* Effect.yieldNow;
    const release = yield* Effect.forkChild(harness.publisher.releaseSession("session-a"));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(harness.continueMint, undefined);
    yield* Fiber.join(lockHolder);
    yield* Fiber.join(renew);
    yield* Fiber.join(release);

    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("rolls back a first publication when minting its launch fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      maxPublications: 1,
      servers: [server(5173), server(5174)],
    });
    yield* Ref.set(harness.mintFailureRef, true);
    expect(
      yield* Effect.flip(
        harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
      ),
    ).toMatchObject({ readiness: "gateway-failed" });
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.revokesRef)).toHaveLength(1);

    yield* Ref.set(harness.mintFailureRef, false);
    yield* harness.publisher.acquire({
      sessionId: "session-b",
      threadId: "thread-a",
      port: 5174,
    });
    expect(yield* Ref.get(harness.startsRef)).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("removes a failed shared lease without tearing down the live publication", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const first = yield* harness.publisher.acquire({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    yield* Ref.set(harness.mintFailureRef, true);
    yield* Effect.flip(
      harness.publisher.acquire({ sessionId: "session-b", threadId: "thread-a", port: 5173 }),
    );
    expect(yield* Ref.get(harness.closesRef)).toEqual([]);

    yield* harness.publisher.release({ sessionId: "session-a", leaseId: first.leaseId });
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("releases every lease held by a disconnected session", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ servers: [server(5173), server(5174)] });
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5174 });
    yield* harness.publisher.releaseSession("session-a");
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000, 43_001]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("expires the final lease and tears down its publication", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ leaseTtl: Duration.seconds(5) });
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });

    yield* TestClock.adjust(Duration.seconds(5));
    yield* Deferred.await(harness.closeSignal);

    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("cleans live publications before the publisher service scope closes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ servers: [server(5173), server(5174)] });
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });
    yield* harness.publisher.acquire({ sessionId: "session-b", threadId: "thread-a", port: 5174 });

    yield* harness.closePublisher;

    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000, 43_001]);
    expect(yield* Ref.get(harness.revokesRef)).toHaveLength(2);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
    expect(yield* Ref.get(harness.discoveryRetainsRef)).toBe(0);
    expect(
      (yield* decodeRegistry(yield* fs.readFileString(config.tailnetPreviewMappingsPath))).mappings,
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect(
  "keeps a vanished publication for fifteen seconds and cancels cleanup on rediscovery",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.publisher.acquire({
        sessionId: "session-a",
        threadId: "thread-a",
        port: 5173,
      });
      yield* harness.pushDiscovery([]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(14));
      expect(yield* Ref.get(harness.closesRef)).toEqual([]);
      yield* harness.pushDiscovery([server(5173, { pid: 99_999 })]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(2));
      expect(yield* Ref.get(harness.closesRef)).toEqual([]);
      yield* harness.pushDiscovery([]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(16));
      yield* Deferred.await(harness.closeSignal);
      expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("explicit disable tears down immediately during disappearance grace", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });
    yield* harness.pushDiscovery([]);
    yield* Effect.yieldNow;

    yield* harness.publisher.setPortEnabled({
      threadId: "thread-a",
      port: 5173,
      enabled: false,
    });

    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("bounds distinct Tailnet publications at sixteen", () =>
  Effect.gen(function* () {
    const servers = Array.from({ length: 17 }, (_, index) => server(5_000 + index));
    const harness = yield* makeHarness({ servers });
    for (const candidate of servers.slice(0, 16)) {
      yield* harness.publisher.acquire({
        sessionId: "session-a",
        threadId: "thread-a",
        port: candidate.port,
      });
    }
    const error = yield* Effect.flip(
      harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5016 }),
    );
    expect(error).toMatchObject({ readiness: "capacity-reached", port: 5016 });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("suppresses only the current discovered process generation", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const lease = yield* harness.publisher.acquire({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    yield* harness.publisher.setPortEnabled({ threadId: "thread-a", port: 5173, enabled: false });
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(
      yield* Effect.flip(
        harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
      ),
    ).toMatchObject({ readiness: "disabled" });
    yield* harness.pushDiscovery([server(5173, { pid: 99_999 })]);
    const replacement = yield* harness.publisher.acquire({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    expect(replacement.leaseId).not.toBe(lease.leaseId);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("keeps suppression across metadata updates and clears it after PID reuse", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.publisher.setPortEnabled({ threadId: "thread-a", port: 5173, enabled: false });
    yield* harness.pushDiscovery([
      server(5173, {
        connectHost: "::1",
        terminal: { threadId: ThreadId.make("thread-a"), terminalId: "terminal-renamed" },
      }),
    ]);
    expect(
      yield* Effect.flip(
        harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
      ),
    ).toMatchObject({ readiness: "disabled" });

    yield* harness.pushDiscovery([]);
    yield* harness.pushDiscovery([server(5173)]);
    expect(
      yield* harness.publisher.acquire({
        sessionId: "session-a",
        threadId: "thread-a",
        port: 5173,
      }),
    ).toMatchObject({ readiness: "ready" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("maps all Tailscale failures to closed readiness values", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Ref.set(harness.tailscaleStatusRef, spawnFailure());
    expect((yield* harness.publisher.status()).readiness).toBe("tailscale-unavailable");
    yield* Ref.set(harness.tailscaleStatusRef, exitFailure("status", "not-logged-in"));
    expect((yield* harness.publisher.status()).readiness).toBe("not-logged-in");
    yield* Ref.set(harness.tailscaleStatusRef, {
      magicDnsName: null,
      tailnetIpv4Addresses: ["100.64.0.1"],
    });
    expect((yield* harness.publisher.status()).readiness).toBe("magic-dns-unavailable");
    yield* Ref.set(harness.tailscaleStatusRef, {
      magicDnsName: "machine.tail.ts.net",
      tailnetIpv4Addresses: ["100.64.0.1"],
    });
    yield* Ref.set(harness.ensureFailureRef, exitFailure("serve", "unknown"));
    expect(
      yield* Effect.flip(
        harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
      ),
    ).toMatchObject({ readiness: "https-unavailable" });
    yield* Ref.set(harness.ensureFailureRef, exitFailure("serve", "permission-denied"));
    expect(
      yield* Effect.flip(
        harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
      ),
    ).toMatchObject({ readiness: "permission-denied" });
    yield* Ref.set(harness.ensureFailureRef, new TailscaleServeConflictError({ servePort: 5173 }));
    expect(
      yield* Effect.flip(
        harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
      ),
    ).toMatchObject({ readiness: "mapping-conflict" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("persists ownership only after a successful mapping", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* Ref.set(harness.ensureFailureRef, exitFailure("serve", "unknown"));
    yield* Effect.flip(
      harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
    );
    expect(yield* fs.exists(config.tailnetPreviewMappingsPath)).toBe(false);
    yield* Ref.set(harness.ensureFailureRef, undefined);
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });
    const persisted = yield* decodeRegistry(
      yield* fs.readFileString(config.tailnetPreviewMappingsPath),
    );
    expect(persisted).toEqual({
      version: 1,
      mappings: [{ servePort: 5173, gatewayPort: 43_001, targetUrl: "http://127.0.0.1:43001" }],
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("rolls back gateway and mapping setup failures without retained state", () =>
  Effect.gen(function* () {
    const gatewayHarness = yield* makeHarness();
    yield* Ref.set(gatewayHarness.gatewayFailureRef, true);
    yield* Effect.flip(
      gatewayHarness.publisher.acquire({
        sessionId: "session-a",
        threadId: "thread-a",
        port: 5173,
      }),
    );
    expect(yield* Ref.get(gatewayHarness.mappingsRef)).toHaveLength(0);
    expect(yield* Ref.get(gatewayHarness.closesRef)).toEqual([]);

    const mappingHarness = yield* makeHarness();
    yield* Ref.set(mappingHarness.ensureFailureRef, exitFailure("serve", "unknown"));
    yield* Effect.flip(
      mappingHarness.publisher.acquire({
        sessionId: "session-a",
        threadId: "thread-a",
        port: 5173,
      }),
    );
    expect(yield* Ref.get(mappingHarness.mappingsRef)).toHaveLength(0);
    expect(yield* Ref.get(mappingHarness.closesRef)).toEqual([43_000]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("rolls back a mapping when its first registry write fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* Ref.set(harness.registryWriteFailuresRef, 1);

    expect(
      yield* Effect.flip(
        harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
      ),
    ).toMatchObject({ readiness: "gateway-failed" });
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* fs.exists(config.tailnetPreviewMappingsPath)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect(
  "persists recovery evidence when registry write and rollback removal both fail",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* Ref.set(harness.registryWriteFailuresRef, 1);
      yield* Ref.set(harness.disableFailureRef, exitFailure("serve", "unknown"));

      expect(
        yield* Effect.flip(
          harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 }),
        ),
      ).toMatchObject({ readiness: "gateway-failed" });
      expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(1);
      expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
      expect(
        (yield* decodeRegistry(yield* fs.readFileString(config.tailnetPreviewMappingsPath)))
          .mappings,
      ).toEqual([{ servePort: 5173, gatewayPort: 43_000, targetUrl: "http://127.0.0.1:43000" }]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("reconciles exact stale, live, absent, and conflicting owned records", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ servers: [server(5173)] });
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });
    yield* Ref.set(
      harness.mappingsRef,
      new Map([
        [5173, { servePort: 5173, proxyUrl: "http://127.0.0.1:43000" }],
        [6000, { servePort: 6000, proxyUrl: "http://127.0.0.1:46000" }],
        [6002, { servePort: 6002, proxyUrl: "http://127.0.0.1:9999" }],
      ]),
    );
    yield* fs.writeFileString(
      config.tailnetPreviewMappingsPath,
      yield* encodeRegistry({
        version: 1,
        mappings: [
          { servePort: 5173, gatewayPort: 43000, targetUrl: "http://127.0.0.1:43000" },
          { servePort: 6000, gatewayPort: 46000, targetUrl: "http://127.0.0.1:46000" },
          { servePort: 6001, gatewayPort: 46001, targetUrl: "http://127.0.0.1:46001" },
          { servePort: 6002, gatewayPort: 46002, targetUrl: "http://127.0.0.1:46002" },
        ],
      }),
    );
    const result = yield* harness.publisher.reconcileStartup();
    expect(result.conflicts).toEqual([6002]);
    expect(yield* Ref.get(harness.mappingsRef)).toEqual(
      new Map([
        [5173, { servePort: 5173, proxyUrl: "http://127.0.0.1:43000" }],
        [6002, { servePort: 6002, proxyUrl: "http://127.0.0.1:9999" }],
      ]),
    );
    expect(
      (yield* decodeRegistry(yield* fs.readFileString(config.tailnetPreviewMappingsPath))).mappings,
    ).toEqual([
      { servePort: 5173, gatewayPort: 43000, targetUrl: "http://127.0.0.1:43000" },
      { servePort: 6002, gatewayPort: 46002, targetUrl: "http://127.0.0.1:46002" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("global opt-out immediately releases exact owned publications", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.publisher.acquire({ sessionId: "session-a", threadId: "thread-a", port: 5173 });
    yield* harness.settings.updateSettings({ tailscalePreviewsEnabled: false });
    yield* harness.publisher.refreshSettings();
    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(0);
    expect(yield* Ref.get(harness.discoveryRetainsRef)).toBe(0);
    expect(yield* harness.publisher.status()).toEqual({ enabled: false, readiness: "disabled" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("keeps exact registry evidence when final mapping removal fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const lease = yield* harness.publisher.acquire({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    yield* Ref.set(harness.disableFailureRef, exitFailure("serve", "unknown"));

    yield* harness.publisher.release({ sessionId: "session-a", leaseId: lease.leaseId });

    expect(yield* Ref.get(harness.closesRef)).toEqual([43_000]);
    expect(yield* Ref.get(harness.mappingsRef)).toHaveLength(1);
    expect(
      (yield* decodeRegistry(yield* fs.readFileString(config.tailnetPreviewMappingsPath))).mappings,
    ).toEqual([{ servePort: 5173, gatewayPort: 43_000, targetUrl: "http://127.0.0.1:43000" }]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

effectIt.effect("does not release another session's lease id", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const lease = yield* harness.publisher.acquire({
      sessionId: "session-a",
      threadId: "thread-a",
      port: 5173,
    });
    const error = yield* Effect.flip(
      harness.publisher.release({ sessionId: "session-b", leaseId: lease.leaseId }),
    );
    expect(error).toBeInstanceOf(PreviewTailnetLeaseNotFoundError);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
