import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
export const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
export const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

// tailscale is a real executable everywhere (`tailscale.exe` on Windows), so
// it is always spawned directly rather than through cmd.exe shell mode.
const tailscaleCommandForPlatform = (platform: NodeJS.Platform): "tailscale" | "tailscale.exe" =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

const TailscaleCommandContext = {
  executable: Schema.Literals(["tailscale", "tailscale.exe"]),
  subcommand: Schema.Literals(["status", "serve"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "not-logged-in",
  "permission-denied",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

// Matched against stderr, most specific first. Patterns are deliberately short
// and anchored on tailscale's own wording.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [
    /handler does not exist|no (?:existing )?(?:web )?handler|no serve config/i,
    "no-existing-handler",
  ],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

/** Classifies stderr into a safe label, dropping the text itself. */
export const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class TailscaleCommandSpawnError extends Schema.TaggedErrorClass<TailscaleCommandSpawnError>()(
  "TailscaleCommandSpawnError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandOutputError extends Schema.TaggedErrorClass<TailscaleCommandOutputError>()(
  "TailscaleCommandOutputError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandExitError extends Schema.TaggedErrorClass<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
    // A classified diagnostic, never raw CLI output. `tailscale` prints auth
    // keys and node identifiers into stderr, and this field is surfaced in
    // dev-runner logs — so it carries only a known-safe label from the closed
    // set below. Callers that need to recognize a specific failure (e.g.
    // `serve off` on a port with no mapping) match on the label.
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedErrorClass<TailscaleCommandTimeoutError>()(
  "TailscaleCommandTimeoutError",
  {
    ...TailscaleCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export const TailscaleCommandError = Schema.Union([
  TailscaleCommandSpawnError,
  TailscaleCommandOutputError,
  TailscaleCommandExitError,
  TailscaleCommandTimeoutError,
]);
export type TailscaleCommandError = typeof TailscaleCommandError.Type;

export class TailscaleStatusParseError extends Schema.TaggedErrorClass<TailscaleStatusParseError>()(
  "TailscaleStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale status JSON.";
  }
}

export class TailscaleServeConfigParseError extends Schema.TaggedErrorClass<TailscaleServeConfigParseError>()(
  "TailscaleServeConfigParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale serve status JSON.";
  }
}

export class TailscaleServeConflictError extends Schema.TaggedErrorClass<TailscaleServeConflictError>()(
  "TailscaleServeConflictError",
  {
    servePort: Schema.Number,
    reason: Schema.optional(Schema.Literals(["different-target", "non-exclusive", "non-loopback"])),
  },
) {
  override get message(): string {
    if (this.reason === "non-loopback") return "Tailscale Serve targets must use loopback.";
    if (this.reason === "non-exclusive") {
      return `Tailscale Serve port ${this.servePort} has additional configuration.`;
    }
    return `Tailscale Serve port ${this.servePort} is owned by a different target.`;
  }
}

export class TailscaleServeLockError extends Schema.TaggedErrorClass<TailscaleServeLockError>()(
  "TailscaleServeLockError",
  {
    servePort: Schema.Number,
    reason: Schema.Literals(["timeout", "unavailable"]),
  },
) {
  override get message(): string {
    return this.reason === "timeout"
      ? `Timed out waiting to update Tailscale Serve port ${this.servePort}.`
      : `Could not lock Tailscale Serve port ${this.servePort} for update.`;
  }
}
const isTailscaleServeLockError = Schema.is(TailscaleServeLockError);

const TailscaleStatusSelf = Schema.Struct({
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

export type TailscaleStatusSelf = typeof TailscaleStatusSelf.Type;
export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
}

const collectStdout = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const collectStderr = collectStdout;

const decodeTailscaleStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleStatusJson));

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export const parseTailscaleMagicDnsName = (
  rawStatusJson: string,
): Effect.Effect<string | null, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map(normalizeMagicDnsName),
  );

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const rawIps = parsed.Self?.TailscaleIPs;
      const tailnetIpv4Addresses: Array<string> = [];
      if (Array.isArray(rawIps)) {
        for (const address of rawIps) {
          if (typeof address === "string" && isTailscaleIpv4Address(address)) {
            tailnetIpv4Addresses.push(address);
          }
        }
      }

      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
      };
    }),
  );

export const readTailscaleStatus = Effect.gen(function* () {
  const args = ["status", "--json"];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const executable = tailscaleCommandForPlatform(hostPlatform);
  const commandContext = {
    executable,
    subcommand: "status" as const,
    argumentCount: args.length,
  };
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(executable, args)).pipe(
      Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
      // Spawning can also fail as a defect rather than a typed error - a
      // non-directory entry on PATH makes node throw ENOTDIR synchronously.
      // `mapError` never sees that, so it would escape as an uncaught error.
      Effect.catchDefect((cause) =>
        Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
      ),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStdout(child.stdout),
        collectStderr(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
    );
    if (exitCode !== 0) {
      return yield* new TailscaleCommandExitError({
        ...commandContext,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        ...(stderrDiagnosticOf(stderr) !== undefined
          ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
          : {}),
      });
    }
    return yield* parseTailscaleStatus(stdout);
  }).pipe(
    Effect.scoped,
    Effect.timeout(TAILSCALE_STATUS_TIMEOUT),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new TailscaleCommandTimeoutError({
            ...commandContext,
            timeoutMs: Duration.toMillis(TAILSCALE_STATUS_TIMEOUT),
            cause,
          }),
        ),
    }),
  );
});

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = "/";
  return url.toString();
}

const runTailscaleCommand = (
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.Effect<string, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    const executable = tailscaleCommandForPlatform(hostPlatform);
    const commandContext = {
      executable,
      subcommand: "serve" as const,
      argumentCount: args.length,
    };
    const timeout = Duration.fromInputUnsafe(timeoutInput);
    return yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(executable, args)).pipe(
        Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        Effect.catchDefect((cause) =>
          Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStdout(child.stdout),
          collectStderr(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(timeout),
              cause,
            }),
          ),
      }),
    );
  });

const normalizeServeProxyUrl = (proxyUrl: string): string | null => {
  try {
    const url = new URL(proxyUrl);
    // Keep path/query differences visible for ownership comparisons. Never
    // retain credentials from a CLI-provided target, though: they are not
    // needed to distinguish a target from the local loopback URL.
    const redactedUserInfo = url.username || url.password ? "redacted@" : "";
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.protocol}//${redactedUserInfo}${url.host}${path}${url.search}${url.hash}`;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const UNKNOWN_SERVE_PROXY_URL = "<unrecognized-serve-target>";

interface TailscaleServeConfigDetails {
  readonly mappings: ReadonlyMap<number, TailscaleServeMapping>;
  readonly exclusivePorts: ReadonlySet<number>;
  readonly occupiedPorts: ReadonlySet<number>;
}

const parseServePort = (rawPort: string): number | null => {
  if (!/^\d+$/u.test(rawPort)) return null;
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
};

const parseWebServePort = (webKey: string): number | null => {
  const match = /:(\d+)$/u.exec(webKey);
  return match?.[1] === undefined ? null : parseServePort(match[1]);
};

const parseTailscaleServeConfigJson = (
  raw: string,
): Effect.Effect<TailscaleServeConfigDetails, TailscaleServeConfigParseError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately do not retain the parser's error: it can quote input and
    // the input comes directly from a CLI that may include sensitive values.
    return Effect.fail(new TailscaleServeConfigParseError({ cause: new Error("invalid JSON") }));
  }

  if (!isRecord(parsed)) {
    return Effect.fail(
      new TailscaleServeConfigParseError({ cause: new Error("serve status is not an object") }),
    );
  }

  const tcp = parsed.TCP;
  const mappings = new Map<number, TailscaleServeMapping>();
  const exclusivePorts = new Set<number>();
  const occupiedPorts = new Set<number>();
  if (!isRecord(tcp) && !isRecord(parsed.Web)) {
    return Effect.succeed({ mappings, exclusivePorts, occupiedPorts });
  }
  const web = isRecord(parsed.Web) ? parsed.Web : {};

  const tcpEntriesByPort = new Map<number, Array<Record<string, unknown> | null>>();
  if (isRecord(tcp)) {
    for (const [rawPort, rawTcpConfig] of Object.entries(tcp)) {
      const servePort = parseServePort(rawPort);
      if (servePort === null) continue;
      occupiedPorts.add(servePort);
      const entries = tcpEntriesByPort.get(servePort) ?? [];
      entries.push(isRecord(rawTcpConfig) ? rawTcpConfig : null);
      tcpEntriesByPort.set(servePort, entries);
    }
  }

  const webEntriesByPort = new Map<number, Array<[string, unknown]>>();
  for (const [webKey, rawWebConfig] of Object.entries(web)) {
    const servePort = parseWebServePort(webKey);
    if (servePort === null) continue;
    occupiedPorts.add(servePort);
    const entries = webEntriesByPort.get(servePort) ?? [];
    entries.push([webKey, rawWebConfig]);
    webEntriesByPort.set(servePort, entries);
  }

  for (const servePort of occupiedPorts) {
    const tcpEntries = tcpEntriesByPort.get(servePort) ?? [];
    const matchingWebEntries = webEntriesByPort.get(servePort) ?? [];
    let proxyUrl = UNKNOWN_SERVE_PROXY_URL;
    let hasExactRootHandler = false;
    for (const [, rawWebConfig] of matchingWebEntries) {
      if (!isRecord(rawWebConfig)) continue;
      const handlers = rawWebConfig.Handlers;
      const rootHandler = isRecord(handlers) && handlers["/"];
      const proxy = isRecord(rootHandler) ? rootHandler.Proxy : undefined;
      if (typeof proxy !== "string") continue;
      const normalizedProxy = normalizeServeProxyUrl(proxy);
      proxyUrl = normalizedProxy ?? UNKNOWN_SERVE_PROXY_URL;
      hasExactRootHandler = normalizedProxy !== null;
      if (hasExactRootHandler) break;
    }
    mappings.set(servePort, { servePort, proxyUrl });
    const tcpConfig = tcpEntries[0];
    const onlyTcpHttpsConfig =
      tcpEntries.length === 1 &&
      tcpConfig !== undefined &&
      tcpConfig !== null &&
      tcpConfig.HTTPS === true &&
      Object.keys(tcpConfig).every((key) => key === "HTTPS");
    const hasOnlyRootHandler =
      matchingWebEntries.length === 1 &&
      (() => {
        const rawWebConfig = matchingWebEntries[0]?.[1];
        if (!isRecord(rawWebConfig) || !isRecord(rawWebConfig.Handlers)) return false;
        return Object.keys(rawWebConfig.Handlers).length === 1;
      })();
    if (
      onlyTcpHttpsConfig &&
      hasOnlyRootHandler &&
      hasExactRootHandler &&
      proxyUrl !== UNKNOWN_SERVE_PROXY_URL
    ) {
      exclusivePorts.add(servePort);
    }
  }
  return Effect.succeed({ mappings, exclusivePorts, occupiedPorts });
};

export interface TailscaleServeMapping {
  readonly servePort: number;
  readonly proxyUrl: string;
}

export type TailscaleServeMutationError =
  | TailscaleCommandError
  | TailscaleServeConfigParseError
  | TailscaleServeConflictError
  | TailscaleServeLockError;

const SERVE_LOCK_WAIT_MS = 5_000;
const SERVE_LOCK_RETRY_MS = 20;
const SERVE_LOCK_INCOMPLETE_STALE_MS = 30_000;

interface ServeMutationLock {
  readonly directory: string;
  readonly ownerPath: string;
  readonly token: string;
}

const ServeMutationLockOwnerSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  token: Schema.String.check(Schema.isMinLength(1)),
});
const ServeMutationLockOwnerJson = Schema.fromJsonString(ServeMutationLockOwnerSchema);
const decodeServeMutationLockOwner = Schema.decodeUnknownOption(ServeMutationLockOwnerJson);
const encodeServeMutationLockOwner = Schema.encodeSync(ServeMutationLockOwnerJson);

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
};

const reclaimStaleServeMutationLock = Effect.fn("reclaimStaleServeMutationLock")(function* (
  lock: ServeMutationLock,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owner = yield* fs.readFileString(lock.ownerPath).pipe(
    Effect.map(decodeServeMutationLockOwner),
    Effect.map(Option.getOrNull),
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

  if (owner !== null && processIsAlive(owner.pid)) return false;
  if (owner === null) {
    const info = yield* fs.stat(lock.directory).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
      ),
    );
    if (Option.isNone(info)) return true;
    const now = yield* Clock.currentTimeMillis;
    const modifiedAt = Option.getOrNull(info.value.mtime)?.getTime() ?? 0;
    if (now - modifiedAt < SERVE_LOCK_INCOMPLETE_STALE_MS) return false;
  }

  const claimPath = path.join(lock.directory, `reclaim-${NodeCrypto.randomUUID()}`);
  const claimed = yield* (
    owner === null
      ? fs.writeFileString(claimPath, "claimed", { flag: "wx", mode: 0o600 })
      : fs.rename(lock.ownerPath, claimPath)
  ).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "AlreadyExists" || error.reason._tag === "NotFound"
        ? Effect.succeed(false)
        : Effect.fail(error),
    ),
  );
  if (!claimed) return false;
  yield* fs.remove(lock.directory, { recursive: true, force: true });
  return true;
});

const acquireServeMutationLock = Effect.fn("acquireServeMutationLock")(function* (
  servePort: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(NodeOS.tmpdir(), "verne-tailscale-serve-locks");
  const directory = path.join(root, `${String(servePort)}.lock`);
  const ownerPath = path.join(directory, "owner.json");
  const token = NodeCrypto.randomUUID();
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = startedAt + SERVE_LOCK_WAIT_MS;
  let attempts = 0;
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });

  while (true) {
    const acquired = yield* fs.makeDirectory(directory, { mode: 0o700 }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
    if (acquired) {
      const lock = { directory, ownerPath, token };
      return yield* fs
        .writeFileString(ownerPath, encodeServeMutationLockOwner({ pid: process.pid, token }), {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.andThen(fs.readFileString(ownerPath)),
          Effect.map(decodeServeMutationLockOwner),
          Effect.flatMap((installed) =>
            Option.isSome(installed) && installed.value.token === token
              ? Effect.succeed(lock)
              : Effect.fail(new TailscaleServeLockError({ servePort, reason: "unavailable" })),
          ),
          Effect.onError(() =>
            fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
    }

    const reclaimed = yield* reclaimStaleServeMutationLock({ directory, ownerPath, token });
    if (reclaimed) continue;
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) {
      return yield* new TailscaleServeLockError({ servePort, reason: "timeout" });
    }
    yield* attempts++ < 8 ? Effect.yieldNow : Effect.sleep(Duration.millis(SERVE_LOCK_RETRY_MS));
  }
});

const releaseServeMutationLock = Effect.fn("releaseServeMutationLock")(function* (
  lock: ServeMutationLock,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owner = yield* fs.readFileString(lock.ownerPath).pipe(
    Effect.map(decodeServeMutationLockOwner),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  if (owner?.token !== lock.token) return;
  const releasePath = path.join(lock.directory, `release-${lock.token}`);
  yield* fs.rename(lock.ownerPath, releasePath);
  yield* fs.remove(lock.directory, { recursive: true, force: true });
});

const withServeMutationLock = <A, E, R>(
  servePort: number,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | TailscaleServeLockError, R> =>
  Effect.acquireUseRelease(
    acquireServeMutationLock(servePort).pipe(
      Effect.mapError((error) =>
        isTailscaleServeLockError(error)
          ? error
          : new TailscaleServeLockError({ servePort, reason: "unavailable" }),
      ),
    ),
    () => effect,
    (lock) => releaseServeMutationLock(lock).pipe(Effect.ignore),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)));

const readTailscaleServeConfigDetails: Effect.Effect<
  TailscaleServeConfigDetails,
  TailscaleCommandError | TailscaleServeConfigParseError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const output = yield* runTailscaleCommand(
    ["serve", "status", "--json"],
    TAILSCALE_SERVE_TIMEOUT,
  ).pipe(
    Effect.catchTags({
      TailscaleCommandExitError: (error) =>
        error.stderrDiagnostic === "no-existing-handler" ? Effect.succeed("") : Effect.fail(error),
    }),
  );
  if (output.trim().length === 0) {
    return {
      mappings: new Map<number, TailscaleServeMapping>(),
      exclusivePorts: new Set<number>(),
      occupiedPorts: new Set<number>(),
    };
  }
  return yield* parseTailscaleServeConfigJson(output);
});

export const readTailscaleServeConfig: Effect.Effect<
  ReadonlyMap<number, TailscaleServeMapping>,
  TailscaleCommandError | TailscaleServeConfigParseError,
  ChildProcessSpawner.ChildProcessSpawner
> = readTailscaleServeConfigDetails.pipe(Effect.map(({ mappings }) => mappings));

const normalizeLoopbackHost = (localHost: string): string | null => {
  const trimmed = localHost.trim().toLowerCase();
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" ? host : null;
};

interface ServeTarget {
  readonly proxyUrl: string;
}

const serveTarget = (
  input: {
    readonly localHost: string;
    readonly localPort: number;
  },
  loopbackOnly: boolean,
): ServeTarget | null => {
  const trimmed = input.localHost.trim().toLowerCase();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const host = loopbackOnly ? normalizeLoopbackHost(unbracketed) : unbracketed;
  if (host === null) return null;
  const targetHost = host.includes(":") ? `[${host}]` : host;
  const proxyUrl = normalizeServeProxyUrl(`http://${targetHost}:${String(input.localPort)}`);
  return proxyUrl === null ? null : { proxyUrl };
};

const ensureExactTailscaleServe = (
  input: { readonly servePort: number },
  target: ServeTarget,
): Effect.Effect<
  "created" | "existing",
  TailscaleServeMutationError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  withServeMutationLock(
    input.servePort,
    Effect.gen(function* () {
      const config = yield* readTailscaleServeConfigDetails;
      if (!config.occupiedPorts.has(input.servePort)) {
        yield* runTailscaleCommand(
          ["serve", "--bg", `--https=${String(input.servePort)}`, target.proxyUrl],
          TAILSCALE_SERVE_TIMEOUT,
        );
        const verified = yield* readTailscaleServeConfigDetails;
        const installed = verified.mappings.get(input.servePort);
        if (
          !verified.exclusivePorts.has(input.servePort) ||
          installed?.proxyUrl !== target.proxyUrl
        ) {
          return yield* new TailscaleServeConflictError({ servePort: input.servePort });
        }
        return "created" as const;
      }
      const existing = config.mappings.get(input.servePort);
      if (existing === undefined) {
        return yield* new TailscaleServeConflictError({
          servePort: input.servePort,
          reason: "non-exclusive",
        });
      }
      if (config.exclusivePorts.has(input.servePort) && existing.proxyUrl === target.proxyUrl) {
        return "existing" as const;
      }
      return yield* new TailscaleServeConflictError({ servePort: input.servePort });
    }),
  );

const disableExactTailscaleServe = (
  input: { readonly servePort: number },
  target: ServeTarget,
): Effect.Effect<
  "removed" | "absent",
  TailscaleServeMutationError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  withServeMutationLock(
    input.servePort,
    Effect.gen(function* () {
      const config = yield* readTailscaleServeConfigDetails;
      if (!config.occupiedPorts.has(input.servePort)) return "absent" as const;
      const existing = config.mappings.get(input.servePort);
      if (existing === undefined) {
        return yield* new TailscaleServeConflictError({
          servePort: input.servePort,
          reason: "non-exclusive",
        });
      }
      if (!config.exclusivePorts.has(input.servePort) || existing.proxyUrl !== target.proxyUrl) {
        return yield* new TailscaleServeConflictError({ servePort: input.servePort });
      }
      yield* runTailscaleCommand(
        ["serve", `--https=${String(input.servePort)}`, "off"],
        TAILSCALE_SERVE_TIMEOUT,
      );
      const verified = yield* readTailscaleServeConfigDetails;
      if (verified.occupiedPorts.has(input.servePort)) {
        return yield* new TailscaleServeConflictError({ servePort: input.servePort });
      }
      return "removed" as const;
    }),
  );

export const ensureOwnedTailscaleServe = (input: {
  readonly servePort: number;
  readonly localHost: string;
  readonly localPort: number;
}): Effect.Effect<
  "created" | "existing",
  TailscaleServeMutationError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const target = serveTarget(input, true);
    if (target === null) {
      return yield* new TailscaleServeConflictError({
        servePort: input.servePort,
        reason: "non-loopback",
      });
    }
    return yield* ensureExactTailscaleServe(input, target);
  });

export const disableOwnedTailscaleServe = (input: {
  readonly servePort: number;
  readonly localHost: string;
  readonly localPort: number;
}): Effect.Effect<
  "removed" | "absent",
  TailscaleServeMutationError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const target = serveTarget(input, true);
    if (target === null) {
      return yield* new TailscaleServeConflictError({
        servePort: input.servePort,
        reason: "non-loopback",
      });
    }
    return yield* disableExactTailscaleServe(input, target);
  });

export const ensureTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
}): Effect.Effect<void, TailscaleServeMutationError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const target = serveTarget({ localHost, localPort: input.localPort }, false);
  if (target === null) {
    return new TailscaleServeConflictError({ servePort });
  }
  return ensureExactTailscaleServe({ servePort }, target).pipe(Effect.asVoid);
};

export const disableTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
}): Effect.Effect<void, TailscaleServeMutationError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const target = serveTarget({ localHost, localPort: input.localPort }, false);
  if (target === null) {
    return new TailscaleServeConflictError({ servePort });
  }
  return disableExactTailscaleServe({ servePort }, target).pipe(Effect.asVoid);
};

export const probeTailscaleHttpsEndpoint = (input: {
  readonly baseUrl: string;
  readonly timeout?: Duration.Input;
}): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/t3/environment", input.baseUrl);
      const request = HttpClientRequest.get(url.toString());
      return yield* client.execute(request);
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.match(response, {
      onNone: () => false,
      onSome: (httpResponse) => httpResponse.status >= 200 && httpResponse.status < 300,
    });
  }).pipe(Effect.orElseSucceed(() => false));

export const resolveTailscaleHttpsBaseUrl = (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.Effect<
  string | null,
  TailscaleCommandError | TailscaleStatusParseError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  readTailscaleStatus.pipe(
    Effect.map((status) =>
      status.magicDnsName
        ? buildTailscaleHttpsBaseUrl({
            magicDnsName: status.magicDnsName,
            ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
          })
        : null,
    ),
  );
