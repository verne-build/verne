import { assert, describe, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  disableOwnedTailscaleServe,
  ensureTailscaleServe,
  ensureOwnedTailscaleServe,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  parseTailscaleStatus,
  readTailscaleStatus,
  readTailscaleServeConfig,
  TAILSCALE_STATUS_TIMEOUT,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
  TailscaleServeConfigParseError,
  TailscaleServeConflictError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

/**
 * Asserts nothing reachable from `error` contains `secret`. Recurses through
 * nested objects, arrays, and `cause` chains rather than checking only
 * top-level strings: a leak one level down (say, a wrapped cause carrying raw
 * stderr) is just as visible in a log, and a shallow check would pass it.
 *
 * Walks values instead of serializing so it holds for fields added later, and
 * tracks visited objects so a cyclic cause chain terminates.
 */
function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;
const tailscaleStatusWithSingleIpJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.90.1.2"]}}`;
const tailscaleServeStatusJson = JSON.stringify({
  TCP: { "3000": { HTTPS: true }, "8443": { HTTPS: true } },
  Web: {
    "host.tailnet.ts.net:3000": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:43121/" } },
    },
    "host.tailnet.ts.net:8443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
    },
  },
  UnknownFutureField: { ignored: true },
});
const tailscaleServeStatusWithSiblingHandlerJson = JSON.stringify({
  TCP: { "3000": { HTTPS: true } },
  Web: {
    "host.tailnet.ts.net:3000": {
      Handlers: {
        "/": { Proxy: "http://127.0.0.1:43121" },
        "/metrics": { Proxy: "http://127.0.0.1:9999" },
      },
    },
  },
});
const tailscaleServeStatusWithWebOnlyJson = JSON.stringify({
  Web: {
    "host.tailnet.ts.net:3000": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:43121" } },
    },
  },
});
const tailscaleServeStatusWithUnsupportedTcpJson = JSON.stringify({
  TCP: { "3000": { HTTPS: false } },
  Web: {
    "host.tailnet.ts.net:3000": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:43121" } },
    },
  },
});
const tailscaleServeStatusWithDuplicateTcpJson = JSON.stringify({
  TCP: {
    "3000": { HTTPS: true },
    "03000": { HTTPS: true },
  },
  Web: {
    "host.tailnet.ts.net:3000": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:43121" } },
    },
  },
});
const tailscaleServeStatusWithDuplicateWebJson = JSON.stringify({
  TCP: { "3000": { HTTPS: true } },
  Web: {
    "host.tailnet.ts.net:3000": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:43121" } },
    },
    "other-host.tailnet.ts.net:03000": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:43121" } },
    },
  },
});

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function neverFinishingMockHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

function sequenceSpawnerLayer(
  results: ReadonlyArray<{ stdout?: string; stderr?: string; code?: number }>,
  onCommand?: (args: ReadonlyArray<string>) => void,
) {
  let index = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      onCommand?.(childProcess.args);
      const result = results[index++];
      assert.isDefined(result);
      return Effect.succeed(mockHandle(result ?? {}));
    }),
  );
}

describe("tailscale", () => {
  it.effect("detects Tailnet IPv4 addresses", () =>
    Effect.sync(() => {
      assert.equal(isTailscaleIpv4Address("100.64.0.1"), true);
      assert.equal(isTailscaleIpv4Address("100.127.255.254"), true);
      assert.equal(isTailscaleIpv4Address("100.128.0.1"), false);
      assert.equal(isTailscaleIpv4Address("192.168.1.44"), false);
    }),
  );

  it.effect("parses MagicDNS names from tailscale status", () =>
    Effect.gen(function* () {
      const dnsName = yield* parseTailscaleMagicDnsName(tailscaleStatusJson);
      assert.equal(dnsName, "desktop.tail.ts.net");
      assert.equal(yield* parseTailscaleMagicDnsName("{}"), null);
    }),
  );

  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
      });
    }),
  );

  it.effect("preserves status decoding failures without exposing cause text", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscaleStatus("{not-json").pipe(Effect.flip);

      assert.instanceOf(error, TailscaleStatusParseError);
      assert.equal(error.message, "Failed to decode tailscale status JSON.");
      assert.isDefined(error.cause);
      assert.notInclude(error.message, String(error.cause));
    }),
  );

  it.effect("builds clean HTTPS base URLs", () =>
    Effect.sync(() => {
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net" }),
        "https://desktop.tail.ts.net/",
      );
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net", servePort: 8443 }),
        "https://desktop.tail.ts.net:8443/",
      );
    }),
  );

  it.effect("reads tailscale status through the process spawner service", () => {
    const layer = mockSpawnerLayer((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["status", "--json"]);
      return {
        stdout: tailscaleStatusWithSingleIpJson,
      };
    });

    return Effect.gen(function* () {
      const status = yield* readTailscaleStatus.pipe(Effect.provide(layer));
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.90.1.2"],
      });
    });
  });

  it.effect("preserves tailscale spawn failures as causes", () => {
    const systemCause = new Error("private executable lookup detail");
    const cause = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: systemCause,
    });
    const layer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.fail(cause)),
    );

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandSpawnError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Failed to spawn tailscale status.");
      assert.notInclude(error.message, systemCause.message);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      // What callers actually rely on: the desktop endpoint providers recover
      // with `Effect.orElseSucceed`, which only sees the typed error channel.
      const degraded = yield* readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = mockSpawnerLayer(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("classifies unrecognized stderr without quoting it", () => {
    const layer = mockSpawnerLayer(() => ({
      code: 3,
      stderr: "something novel went wrong for node fluffy-badger tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      // Unmatched stderr degrades to "unknown" rather than passing text
      // through — that fallback is what keeps novel output from leaking.
      assert.equal(error.stderrDiagnostic, "unknown");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
      assertCarriesNoSecret(error, "fluffy-badger");
    });
  });

  it.effect("times out tailscale status through TestClock", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(neverFinishingMockHandle())),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* readTailscaleStatus.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(TAILSCALE_STATUS_TIMEOUT);
      const error = yield* Fiber.join(fiber);

      assert.instanceOf(error, TailscaleCommandTimeoutError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.timeoutMs, 1_500);
      assert.isTrue(Cause.isTimeoutError(error.cause));
      assert.equal(error.message, "tailscale status timed out after 1500ms.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("configures tailscale serve through the process spawner service", () => {
    const layer = sequenceSpawnerLayer([
      { stdout: "{}" },
      {},
      {
        stdout: JSON.stringify({
          TCP: { "8443": { HTTPS: true } },
          Web: {
            "host.tailnet.ts.net:8443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:13773" } },
            },
          },
        }),
      },
    ]);

    return ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(Effect.provide(layer));
  });

  it.effect("keeps pairing-compatible non-loopback targets exact and serialized", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [
        { stdout: "{}" },
        {},
        {
          stdout: JSON.stringify({
            TCP: { "8443": { HTTPS: true } },
            Web: {
              "host.tailnet.ts.net:8443": {
                Handlers: { "/": { Proxy: "http://192.168.1.20:13773" } },
              },
            },
          }),
        },
      ],
      (args) => commands.push(args),
    );

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({
        localPort: 13773,
        servePort: 8443,
        localHost: "192.168.1.20",
      }).pipe(Effect.provide(layer));

      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://192.168.1.20:13773"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("retains tailscale serve exit diagnostics", () => {
    const layer = sequenceSpawnerLayer([
      { stdout: "{}" },
      { code: 1, stderr: "serve permission denied tskey-auth-secret-token-value" },
    ]);

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "serve");
      assert.equal(error.argumentCount, 4);
      assert.equal(error.exitCode, 1);
      assert.equal(error.stderrLength, 53);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      // The diagnostic classifies the failure without quoting stderr, so the
      // key cannot reach a log through it either.
      assert.equal(error.stderrDiagnostic, "permission-denied");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("disables tailscale serve through the process spawner service", () => {
    const commands: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }[] = [];
    const layer = sequenceSpawnerLayer(
      [{ stdout: tailscaleServeStatusJson }, {}, { stdout: "{}" }],
      (args) => commands.push({ command: "tailscale", args }),
    );

    return Effect.gen(function* () {
      yield* disableTailscaleServe({ servePort: 8443, localPort: 9999 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        { command: "tailscale", args: ["serve", "status", "--json"] },
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
        { command: "tailscale", args: ["serve", "status", "--json"] },
      ]);
    });
  });

  it.effect("serializes the server-share wrapper with owned preview mutations", () =>
    Effect.gen(function* () {
      const initialStatusStarted = yield* Deferred.make<void>();
      const releaseInitialStatus = yield* Deferred.make<void>();
      let proxyUrl: string | null = null;
      let mutationCount = 0;

      const layer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const args = "args" in command ? (command.args as ReadonlyArray<string>) : [];
          if (args[0] === "serve" && args[1] === "status") {
            const snapshot =
              proxyUrl === null
                ? "{}"
                : JSON.stringify({
                    TCP: { "54734": { HTTPS: true } },
                    Web: {
                      "host.tailnet.ts.net:54734": {
                        Handlers: { "/": { Proxy: proxyUrl } },
                      },
                    },
                  });
            const stdout =
              proxyUrl === null
                ? Stream.fromEffect(
                    Deferred.succeed(initialStatusStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseInitialStatus)),
                      Effect.as(encoder.encode(snapshot)),
                    ),
                  )
                : Stream.make(encoder.encode(snapshot));
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                ...mockHandle({}),
                stdout,
              }),
            );
          }
          if (args[0] === "serve" && args[1] === "--bg") {
            mutationCount += 1;
            proxyUrl = args[3] ?? null;
          }
          return Effect.succeed(mockHandle({}));
        }),
      );

      const owned = ensureOwnedTailscaleServe({
        servePort: 54734,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(
        Effect.map((value) => ({ _tag: "Success" as const, value })),
        Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
        Effect.provide(layer),
      );
      const serverShare = ensureTailscaleServe({
        servePort: 54734,
        localHost: "127.0.0.1",
        localPort: 43122,
      }).pipe(
        Effect.map(() => ({ _tag: "Success" as const })),
        Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
        Effect.provide(layer),
      );

      const ownedFiber = yield* Effect.forkChild(owned, { startImmediately: true });
      yield* Deferred.await(initialStatusStarted);
      const shareFiber = yield* Effect.forkChild(serverShare, { startImmediately: true });
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseInitialStatus, undefined);
      const results = [yield* Fiber.join(ownedFiber), yield* Fiber.join(shareFiber)];

      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
      assert.equal(mutationCount, 1);
    }),
  );

  it.effect("preserves a mismatched mapping during server-share cleanup", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer([{ stdout: tailscaleServeStatusJson }], (args) =>
      commands.push(args),
    );

    return Effect.gen(function* () {
      const error = yield* disableTailscaleServe({
        servePort: 8443,
        localPort: 13773,
      }).pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleServeConflictError);
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  it.effect("reads and parses the JSON Serve config while tolerating unknown fields", () => {
    const layer = mockSpawnerLayer((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["serve", "status", "--json"]);
      return { stdout: tailscaleServeStatusJson };
    });

    return Effect.gen(function* () {
      const config = yield* readTailscaleServeConfig.pipe(Effect.provide(layer));
      assert.deepEqual(
        [...config.entries()],
        [
          [3000, { servePort: 3000, proxyUrl: "http://127.0.0.1:43121" }],
          [8443, { servePort: 8443, proxyUrl: "http://127.0.0.1:9999" }],
        ],
      );
    });
  });

  it.effect("treats no existing Serve handler output as an empty config", () => {
    const layer = mockSpawnerLayer(() => ({
      code: 1,
      stderr: "error: failed to get web serve: handler does not exist",
    }));

    return Effect.gen(function* () {
      const config = yield* readTailscaleServeConfig.pipe(Effect.provide(layer));
      assert.equal(config.size, 0);
    });
  });

  it.effect("treats empty Serve status output as an empty config", () => {
    const layer = mockSpawnerLayer(() => ({ stdout: "\n" }));

    return Effect.gen(function* () {
      const config = yield* readTailscaleServeConfig.pipe(Effect.provide(layer));
      assert.equal(config.size, 0);
    });
  });

  it.effect("keeps missing-daemon Serve diagnostics classified and secret-free", () => {
    const secret = "tskey-auth-secret-token-value";
    const layer = mockSpawnerLayer(() => ({
      code: 1,
      stderr: `failed to connect to local tailscaled: ${secret}`,
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleServeConfig.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.stderrDiagnostic, "unknown");
      assertCarriesNoSecret(error, secret);
    });
  });

  it.effect("reports malformed Serve JSON as a typed parse error without raw output", () => {
    const secret = "tskey-auth-secret-token-value";
    const layer = mockSpawnerLayer(() => ({ stdout: `{not-json ${secret}` }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleServeConfig.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServeConfigParseError);
      assert.equal(error.message, "Failed to decode tailscale serve status JSON.");
      assertCarriesNoSecret(error, secret);
    });
  });

  it.effect("does not mutate an exact owned mapping", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer([{ stdout: tailscaleServeStatusJson }], (args) => {
      commands.push(args);
    });

    return Effect.gen(function* () {
      const result = yield* ensureOwnedTailscaleServe({
        servePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.provide(layer));
      assert.equal(result, "existing");
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  it.effect("creates an absent owned mapping after reading config", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [
        { stdout: tailscaleServeStatusJson },
        {},
        {
          stdout: JSON.stringify({
            TCP: { "5000": { HTTPS: true } },
            Web: {
              "host.tailnet.ts.net:5000": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:43121" } },
              },
            },
          }),
        },
      ],
      (args) => {
        commands.push(args);
      },
    );

    return Effect.gen(function* () {
      const result = yield* ensureOwnedTailscaleServe({
        servePort: 5000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.provide(layer));
      assert.equal(result, "created");
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=5000", "http://127.0.0.1:43121"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("serializes competing owners of the same Serve port", () => {
    let proxyUrl: string | null = null;
    const commands: Array<ReadonlyArray<string>> = [];
    const makeIndependentLayer = () =>
      mockSpawnerLayer((_command, args) => {
        commands.push(args);
        if (args[0] === "serve" && args[1] === "status") {
          return proxyUrl === null
            ? { stdout: "{}" }
            : {
                stdout: JSON.stringify({
                  TCP: { "54731": { HTTPS: true } },
                  Web: {
                    "host.tailnet.ts.net:54731": {
                      Handlers: { "/": { Proxy: proxyUrl } },
                    },
                  },
                }),
              };
        }
        if (args[0] === "serve" && args[1] === "--bg") {
          proxyUrl = args[3] ?? null;
        }
        return {};
      });

    const attempt = (localPort: number) =>
      ensureOwnedTailscaleServe({
        servePort: 54731,
        localHost: "127.0.0.1",
        localPort,
      }).pipe(
        Effect.map((value) => ({ _tag: "Success" as const, value })),
        Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
        Effect.provide(makeIndependentLayer()),
      );

    return Effect.gen(function* () {
      const results = yield* Effect.all([attempt(43121), attempt(43122)], {
        concurrency: "unbounded",
      });

      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");
      assert.equal(successes.length, 1);
      assert.equal(successes[0]?.value, "created");
      assert.equal(failures.length, 1);
      if (failures[0]?._tag === "Failure") {
        assert.instanceOf(failures[0].error, TailscaleServeConflictError);
      }
      assert.include(["http://127.0.0.1:43121", "http://127.0.0.1:43122"], proxyUrl);
      assert.equal(commands.filter((args) => args[0] === "serve" && args[1] === "--bg").length, 1);
    });
  });

  it.effect("rejects a successful Serve command when verification finds another owner", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [
        { stdout: "{}" },
        {},
        {
          stdout: JSON.stringify({
            TCP: { "54732": { HTTPS: true } },
            Web: {
              "host.tailnet.ts.net:54732": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:49999" } },
              },
            },
          }),
        },
      ],
      (args) => commands.push(args),
    );

    return Effect.gen(function* () {
      const error = yield* ensureOwnedTailscaleServe({
        servePort: 54732,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleServeConflictError);
      assert.equal(error.servePort, 54732);
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=54732", "http://127.0.0.1:43121"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("recovers a lock left by a terminated Verne process", () => {
    const servePort = 54733;
    const layer = sequenceSpawnerLayer([
      { stdout: "{}" },
      {},
      {
        stdout: JSON.stringify({
          TCP: { "54733": { HTTPS: true } },
          Web: {
            "host.tailnet.ts.net:54733": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:43121" } },
            },
          },
        }),
      },
    ]);

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockDirectory = path.join(
        NodeOS.tmpdir(),
        "verne-tailscale-serve-locks",
        `${String(servePort)}.lock`,
      );
      return yield* Effect.acquireUseRelease(
        fs
          .makeDirectory(lockDirectory, { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                path.join(lockDirectory, "owner.json"),
                '{"pid":2147483647,"token":"terminated-owner"}',
              ),
            ),
          ),
        () =>
          Effect.gen(function* () {
            const result = yield* ensureOwnedTailscaleServe({
              servePort,
              localHost: "127.0.0.1",
              localPort: 43121,
            }).pipe(Effect.provide(layer));

            assert.equal(result, "created");
            assert.equal(yield* fs.exists(lockDirectory), false);
          }),
        () => fs.remove(lockDirectory, { recursive: true, force: true }),
      );
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)));
  });

  it.effect("refuses to overwrite a different target", () => {
    const layer = sequenceSpawnerLayer([{ stdout: tailscaleServeStatusJson }]);

    return Effect.gen(function* () {
      const error = yield* ensureOwnedTailscaleServe({
        servePort: 8443,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServeConflictError);
      assert.equal(error.servePort, 8443);
      assert.equal(error.message, "Tailscale Serve port 8443 is owned by a different target.");
    });
  });

  it.effect("removes only an exact owned mapping", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [{ stdout: tailscaleServeStatusJson }, {}, { stdout: "{}" }],
      (args) => {
        commands.push(args);
      },
    );

    return Effect.gen(function* () {
      const result = yield* disableOwnedTailscaleServe({
        servePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.provide(layer));
      assert.equal(result, "removed");
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--https=3000", "off"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("rejects a successful Serve removal when verification finds the port occupied", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [{ stdout: tailscaleServeStatusJson }, {}, { stdout: tailscaleServeStatusJson }],
      (args) => commands.push(args),
    );

    return Effect.gen(function* () {
      const error = yield* disableOwnedTailscaleServe({
        servePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleServeConflictError);
      assert.equal(error.servePort, 3000);
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--https=3000", "off"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("does not mutate when the owned mapping is absent", () => {
    const layer = sequenceSpawnerLayer([{ stdout: tailscaleServeStatusJson }]);

    return Effect.gen(function* () {
      const result = yield* disableOwnedTailscaleServe({
        servePort: 5000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.provide(layer));
      assert.equal(result, "absent");
    });
  });

  it.effect("refuses to remove a mismatched target", () => {
    const layer = sequenceSpawnerLayer([{ stdout: tailscaleServeStatusJson }]);

    return Effect.gen(function* () {
      const error = yield* disableOwnedTailscaleServe({
        servePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43122,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServeConflictError);
      assert.equal(error.servePort, 3000);
    });
  });

  it.effect("refuses to ensure an owned root when a sibling handler shares its port", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [{ stdout: tailscaleServeStatusWithSiblingHandlerJson }],
      (args) => commands.push(args),
    );

    return Effect.gen(function* () {
      const error = yield* ensureOwnedTailscaleServe({
        servePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServeConflictError);
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  it.effect("refuses to disable an owned root when a sibling handler shares its port", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [{ stdout: tailscaleServeStatusWithSiblingHandlerJson }],
      (args) => commands.push(args),
    );

    return Effect.gen(function* () {
      const error = yield* disableOwnedTailscaleServe({
        servePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServeConflictError);
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  it.effect("rejects a LAN target before reading or mutating Serve", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer([], (args) => commands.push(args));

    return Effect.gen(function* () {
      const ensureError = yield* ensureOwnedTailscaleServe({
        servePort: 3000,
        localHost: "192.168.1.20",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(ensureError, TailscaleServeConflictError);
      assert.equal(commands.length, 0);
    });
  });

  it.effect("rejects a LAN target before disabling Serve", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer([], (args) => commands.push(args));

    return Effect.gen(function* () {
      const error = yield* disableOwnedTailscaleServe({
        servePort: 3000,
        localHost: "10.0.0.8",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServeConflictError);
      assert.equal(commands.length, 0);
    });
  });

  it.effect("supports localhost and IPv6 loopback targets", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer(
      [
        { stdout: "{}" },
        {},
        {
          stdout: JSON.stringify({
            TCP: { "3000": { HTTPS: true } },
            Web: {
              "host.tailnet.ts.net:3000": {
                Handlers: { "/": { Proxy: "http://localhost:43121" } },
              },
            },
          }),
        },
        { stdout: "{}" },
        {},
        {
          stdout: JSON.stringify({
            TCP: { "3001": { HTTPS: true } },
            Web: {
              "host.tailnet.ts.net:3001": {
                Handlers: { "/": { Proxy: "http://[::1]:43121" } },
              },
            },
          }),
        },
      ],
      (args) => commands.push(args),
    );

    return Effect.gen(function* () {
      assert.equal(
        yield* ensureOwnedTailscaleServe({
          servePort: 3000,
          localHost: "localhost",
          localPort: 43121,
        }).pipe(Effect.provide(layer)),
        "created",
      );
      assert.equal(
        yield* ensureOwnedTailscaleServe({
          servePort: 3001,
          localHost: "::1",
          localPort: 43121,
        }).pipe(Effect.provide(layer)),
        "created",
      );
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=3000", "http://localhost:43121"],
        ["serve", "status", "--json"],
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=3001", "http://[::1]:43121"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect.each([
    ["Web config without TCP", tailscaleServeStatusWithWebOnlyJson],
    ["unsupported TCP config with Web", tailscaleServeStatusWithUnsupportedTcpJson],
    ["duplicate numeric TCP keys", tailscaleServeStatusWithDuplicateTcpJson],
    ["duplicate numeric Web keys", tailscaleServeStatusWithDuplicateWebJson],
  ] as const)("refuses to create over occupied port: %s", ([, stdout]) => {
    const commands: Array<ReadonlyArray<string>> = [];
    const layer = sequenceSpawnerLayer([{ stdout }], (args) => commands.push(args));

    return Effect.gen(function* () {
      const error = yield* ensureOwnedTailscaleServe({
        servePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43121,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServeConflictError);
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });
});
