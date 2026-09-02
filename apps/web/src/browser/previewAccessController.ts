import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type {
  BrowserNavigationTarget,
  DiscoveredLocalServer,
  EnvironmentId,
  PreviewTailnetAcquireResult,
  PreviewTailnetStatusResult,
  PreviewUrlResolution,
  TailnetPreviewReadiness,
  ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { readPreparedConnection } from "~/state/session";
import { previewTailnetRpc } from "~/state/preview";
import {
  isLoopbackBrowserNavigationTarget,
  resolveDirectBrowserNavigationTarget,
} from "./browserTargetResolver";
import { prepareBrowserNavigationTarget } from "./prepareBrowserNavigationTarget";

const MAX_AUTOMATIC_PORTS = 16;
const DISAPPEARANCE_GRACE_MS = 15_000;
const RENEWAL_MARGIN_MS = 15_000;
const MIN_RENEWAL_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;

export interface PreviewAccessEnvironment {
  readonly connection: {
    readonly httpBaseUrl: string;
    readonly target: ConnectionTarget;
  };
  readonly tailnetPreviewPublishing:
    | { readonly protocolVersion: 1; readonly requiredScope: "preview:access" }
    | undefined;
  readonly tailscalePreviewsEnabled: boolean;
}

interface TailnetOperationInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly port: number;
}

export interface PreviewAccessControllerDependencies {
  readonly surface: "desktop" | "web";
  readonly readEnvironment: (environmentId: EnvironmentId) => PreviewAccessEnvironment | null;
  readonly prepareDesktop: (input: {
    readonly environmentId: EnvironmentId;
    readonly target: BrowserNavigationTarget;
  }) => Promise<PreviewUrlResolution>;
  readonly tailnet: {
    readonly status: (input: {
      readonly environmentId: EnvironmentId;
    }) => Promise<PreviewTailnetStatusResult>;
    readonly acquire: (input: TailnetOperationInput) => Promise<PreviewTailnetAcquireResult>;
    readonly renew: (input: TailnetOperationInput) => Promise<PreviewTailnetAcquireResult>;
    readonly release: (input: {
      readonly environmentId: EnvironmentId;
      readonly leaseId: string;
    }) => Promise<void>;
    readonly setPortEnabled: (
      input: TailnetOperationInput & { readonly enabled: boolean },
    ) => Promise<PreviewTailnetStatusResult>;
  };
  readonly timers: {
    readonly setTimeout: (callback: () => void | Promise<void>, delayMs: number) => unknown;
    readonly clearTimeout: (timer: unknown) => void;
  };
  readonly now: () => number;
}

export type PreviewAccessResolution =
  | {
      readonly state: "ready";
      readonly transport: "direct" | "desktop-forward" | "tailnet";
      readonly requestedUrl: string;
      readonly cleanUrl: string;
      readonly launchUrl: string;
      readonly resolutionKind: PreviewUrlResolution["resolutionKind"] | "tailnet-publication";
      readonly readiness: "ready";
    }
  | {
      readonly state: "unsupported";
      readonly requestedUrl: string;
      readonly cleanUrl: string;
    }
  | {
      readonly state: "setup-required";
      readonly requestedUrl: string;
      readonly cleanUrl: string;
      readonly readiness: "disabled";
    }
  | {
      readonly state: "unavailable";
      readonly requestedUrl: string;
      readonly cleanUrl: string;
      readonly readiness: TailnetPreviewReadiness;
    };

export type PreviewAccessPortState =
  | { readonly state: "idle" }
  | { readonly state: "suppressed" }
  | {
      readonly state: "active" | "disappearing";
      readonly cleanUrl: string;
      readonly expiresAt: string;
    }
  | { readonly state: "unavailable"; readonly readiness: TailnetPreviewReadiness };

export interface PreviewAccessPrepareInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly target: BrowserNavigationTarget;
}

export type PreviewAccessReconcileStatus =
  | PreviewTailnetStatusResult
  | { readonly state: "error"; readonly readiness: TailnetPreviewReadiness }
  | null;

export interface PreviewAccessReconcileInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly status?: PreviewAccessReconcileStatus;
}

export interface PreviewAccessController {
  readonly prepare: (input: PreviewAccessPrepareInput) => Promise<PreviewAccessResolution>;
  readonly reconcile: (input: PreviewAccessReconcileInput) => Promise<void>;
  readonly setPortEnabled: (
    input: TailnetOperationInput & { readonly enabled: boolean },
  ) => Promise<void>;
  readonly getPortState: (input: TailnetOperationInput) => PreviewAccessPortState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly cleanup: () => Promise<void>;
}

interface OwnedLease {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly port: number;
  readonly leaseId: string;
  readonly cleanUrl: string;
  readonly expiresAt: string;
}

interface PendingLeaseOperation {
  readonly intentEpoch: number;
  readonly promise: Promise<PreviewTailnetAcquireResult>;
}

const keyFor = (input: TailnetOperationInput) =>
  JSON.stringify([input.environmentId, input.threadId, input.port]);

const requestedUrlFor = (target: BrowserNavigationTarget): string => {
  if (target.kind === "url") return target.url;
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  return `${protocol}://localhost:${target.port}${path}`;
};

const portFor = (target: BrowserNavigationTarget): number | null => {
  if (target.kind === "environment-port") return target.port;
  try {
    const url = new URL(normalizePreviewUrl(target.url));
    return Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
};

const isDesktopLocal = (target: ConnectionTarget): boolean =>
  target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);

const readinessFromError = (error: unknown): TailnetPreviewReadiness | null => {
  if (
    typeof error === "object" &&
    error !== null &&
    "readiness" in error &&
    typeof error.readiness === "string"
  ) {
    return error.readiness as TailnetPreviewReadiness;
  }
  return null;
};

class PreviewAccessIntentCancelledError extends Error {
  readonly readiness = "disabled" as const;
}

export function createPreviewAccessController(
  dependencies: PreviewAccessControllerDependencies,
): PreviewAccessController {
  const leases = new Map<string, OwnedLease>();
  const states = new Map<string, PreviewAccessPortState>();
  const pending = new Map<string, PendingLeaseOperation>();
  const disappearanceTimers = new Map<string, unknown>();
  const disappearanceDeadlines = new Map<string, number>();
  const renewalTimers = new Map<string, unknown>();
  const retryTimers = new Map<string, unknown>();
  const retryAttempts = new Map<string, number>();
  const desiredKeys = new Set<string>();
  const suppressed = new Map<string, number>();
  const observations = new Map<
    string,
    { readonly present: boolean; readonly pid: number | null; readonly lifetime: number }
  >();
  const needsEnable = new Set<string>();
  const intentEpochs = new Map<string, number>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let cleanupPromise: Promise<void> | undefined;

  const publish = () => {
    for (const listener of listeners) listener();
  };

  const intentEpoch = (key: string) => intentEpochs.get(key) ?? 0;
  const advanceIntent = (key: string) => intentEpochs.set(key, intentEpoch(key) + 1);
  const isSuppressed = (key: string) => {
    const suppressedLifetime = suppressed.get(key);
    if (suppressedLifetime === undefined) return false;
    return suppressedLifetime === (observations.get(key)?.lifetime ?? 0);
  };

  const setState = (key: string, state: PreviewAccessPortState) => {
    states.set(key, state);
    publish();
  };

  const clearDisappearanceTimer = (key: string) => {
    const timer = disappearanceTimers.get(key);
    if (timer !== undefined) dependencies.timers.clearTimeout(timer);
    disappearanceTimers.delete(key);
  };

  const cancelDisappearance = (key: string) => {
    clearDisappearanceTimer(key);
    disappearanceDeadlines.delete(key);
  };

  const clearRenewalTimer = (key: string) => {
    const timer = renewalTimers.get(key);
    if (timer !== undefined) dependencies.timers.clearTimeout(timer);
    renewalTimers.delete(key);
  };

  const clearRetryTimer = (key: string) => {
    const timer = retryTimers.get(key);
    if (timer !== undefined) dependencies.timers.clearTimeout(timer);
    retryTimers.delete(key);
  };

  let ensureLease!: (input: TailnetOperationInput) => Promise<void>;

  const retryAllowed = (input: TailnetOperationInput) => {
    if (disposed || !desiredKeys.has(keyFor(input)) || isSuppressed(keyFor(input))) return false;
    const environment = dependencies.readEnvironment(input.environmentId);
    return (
      environment?.tailnetPreviewPublishing?.protocolVersion === 1 &&
      environment.tailscalePreviewsEnabled
    );
  };

  const scheduleRetry = (input: TailnetOperationInput) => {
    const key = keyFor(input);
    if (!retryAllowed(input) || retryTimers.has(key)) return;
    const attempt = retryAttempts.get(key) ?? 0;
    const delayMs = Math.min(MAX_RETRY_DELAY_MS, MIN_RENEWAL_DELAY_MS * 2 ** attempt);
    retryAttempts.set(key, attempt + 1);
    const timer = dependencies.timers.setTimeout(async () => {
      retryTimers.delete(key);
      if (retryAllowed(input)) await ensureLease(input);
    }, delayMs);
    retryTimers.set(key, timer);
  };

  const scheduleRenewal = (input: TailnetOperationInput, expiresAt: string) => {
    const key = keyFor(input);
    clearRenewalTimer(key);
    const delayMs = Math.max(
      MIN_RENEWAL_DELAY_MS,
      Date.parse(expiresAt) - dependencies.now() - RENEWAL_MARGIN_MS,
    );
    const timer = dependencies.timers.setTimeout(async () => {
      renewalTimers.delete(key);
      await ensureLease(input);
    }, delayMs);
    renewalTimers.set(key, timer);
  };

  const remember = (
    input: TailnetOperationInput,
    result: PreviewTailnetAcquireResult,
    state: "active" | "disappearing" = "active",
  ) => {
    const key = keyFor(input);
    clearRetryTimer(key);
    retryAttempts.delete(key);
    leases.set(key, {
      ...input,
      leaseId: result.leaseId,
      cleanUrl: result.cleanUrl,
      expiresAt: result.expiresAt,
    });
    setState(key, {
      state,
      cleanUrl: result.cleanUrl,
      expiresAt: result.expiresAt,
    });
    if (state === "active") scheduleRenewal(input, result.expiresAt);
  };

  const singleFlight = async (
    input: TailnetOperationInput,
    operation: () => Promise<PreviewTailnetAcquireResult>,
    startedAtIntent: number,
  ): Promise<PreviewTailnetAcquireResult> => {
    const key = keyFor(input);
    while (true) {
      const active = pending.get(key);
      if (active !== undefined) {
        if (active.intentEpoch === startedAtIntent) return active.promise;
        await active.promise.catch(() => undefined);
        if (pending.get(key) === active) pending.delete(key);
        continue;
      }
      if (disposed || isSuppressed(key) || intentEpoch(key) !== startedAtIntent) {
        throw new PreviewAccessIntentCancelledError();
      }

      const promise = (async () => {
        let result: PreviewTailnetAcquireResult;
        try {
          result = await operation();
        } catch (error) {
          if (disposed || isSuppressed(key) || intentEpoch(key) !== startedAtIntent) {
            throw new PreviewAccessIntentCancelledError();
          }
          throw error;
        }
        if (disposed || isSuppressed(key) || intentEpoch(key) !== startedAtIntent) {
          await dependencies.tailnet
            .release({ environmentId: input.environmentId, leaseId: result.leaseId })
            .catch(() => undefined);
          throw new PreviewAccessIntentCancelledError();
        }
        return result;
      })();
      const current = { intentEpoch: startedAtIntent, promise };
      pending.set(key, current);
      void promise.then(
        () => {
          if (pending.get(key) === current) pending.delete(key);
        },
        () => {
          if (pending.get(key) === current) pending.delete(key);
        },
      );
      return promise;
    }
  };

  const acquireFresh = async (input: TailnetOperationInput) => {
    if (disposed) throw new Error("This preview access controller has been disposed.");
    const key = keyFor(input);
    const startedAtIntent = intentEpoch(key);
    const result = await singleFlight(
      input,
      () => dependencies.tailnet.acquire(input),
      startedAtIntent,
    );
    remember(input, result);
    return result;
  };

  ensureLease = async (input: TailnetOperationInput) => {
    const key = keyFor(input);
    if (disposed || isSuppressed(key)) return;
    const startedAtIntent = intentEpoch(key);
    try {
      const result = await singleFlight(
        input,
        () =>
          leases.has(key) ? dependencies.tailnet.renew(input) : dependencies.tailnet.acquire(input),
        startedAtIntent,
      );
      if (!desiredKeys.has(key)) {
        const deadline = disappearanceDeadlines.get(key);
        if (deadline === undefined || deadline <= dependencies.now()) {
          await dependencies.tailnet
            .release({ environmentId: input.environmentId, leaseId: result.leaseId })
            .catch(() => undefined);
          states.delete(key);
          publish();
          return;
        }
        remember(input, result, "disappearing");
        return;
      }
      remember(input, result);
    } catch (error) {
      if (error instanceof PreviewAccessIntentCancelledError) return;
      clearRenewalTimer(key);
      const staleLease = leases.get(key);
      leases.delete(key);
      if (staleLease !== undefined) {
        await dependencies.tailnet
          .release({ environmentId: staleLease.environmentId, leaseId: staleLease.leaseId })
          .catch(() => undefined);
      }
      if (!isSuppressed(key)) {
        setState(key, {
          state: "unavailable",
          readiness: readinessFromError(error) ?? "gateway-failed",
        });
        scheduleRetry(input);
      }
    }
  };

  const releaseKey = async (key: string) => {
    clearDisappearanceTimer(key);
    clearRenewalTimer(key);
    clearRetryTimer(key);
    retryAttempts.delete(key);
    const lease = leases.get(key);
    leases.delete(key);
    if (!isSuppressed(key)) states.delete(key);
    if (lease === undefined) return;
    publish();
    await dependencies.tailnet.release({
      environmentId: lease.environmentId,
      leaseId: lease.leaseId,
    });
  };

  const scheduleDisappearance = (input: TailnetOperationInput) => {
    const key = keyFor(input);
    if (disappearanceDeadlines.has(key)) return;
    const deadline = dependencies.now() + DISAPPEARANCE_GRACE_MS;
    disappearanceDeadlines.set(key, deadline);
    clearRenewalTimer(key);
    const lease = leases.get(key);
    if (lease !== undefined) {
      setState(key, {
        state: "disappearing",
        cleanUrl: lease.cleanUrl,
        expiresAt: lease.expiresAt,
      });
    }
    const timer = dependencies.timers.setTimeout(async () => {
      disappearanceTimers.delete(key);
      await releaseKey(key).catch(() => undefined);
      if (!pending.has(key)) disappearanceDeadlines.delete(key);
    }, DISAPPEARANCE_GRACE_MS);
    disappearanceTimers.set(key, timer);
  };

  const releaseMatching = async (environmentId: EnvironmentId, threadId: ThreadId) => {
    const scopedKeys = new Set([
      ...leases.keys(),
      ...pending.keys(),
      ...desiredKeys,
      ...retryTimers.keys(),
      ...renewalTimers.keys(),
      ...disappearanceTimers.keys(),
      ...states.keys(),
    ]);
    const matchingKeys = [...scopedKeys].filter((key) => {
      const [keyEnvironmentId, keyThreadId] = JSON.parse(key) as [string, string, number];
      return keyEnvironmentId === environmentId && keyThreadId === threadId;
    });
    for (const key of matchingKeys) {
      desiredKeys.delete(key);
      advanceIntent(key);
    }
    await Promise.allSettled(matchingKeys.map((key) => releaseKey(key)));
  };

  const observeProcesses = (input: PreviewAccessReconcileInput) => {
    const current = new Map(
      input.servers
        .filter((server) => server.terminal?.threadId === input.threadId)
        .map((server) => [
          keyFor({
            environmentId: input.environmentId,
            threadId: input.threadId,
            port: server.port,
          }),
          server,
        ]),
    );
    const inScope = (key: string) => {
      const [keyEnvironmentId, keyThreadId] = JSON.parse(key) as [string, string, number];
      return keyEnvironmentId === input.environmentId && keyThreadId === input.threadId;
    };

    for (const [key, previous] of observations) {
      if (!inScope(key) || current.has(key) || !previous.present) continue;
      observations.set(key, { ...previous, present: false });
      if (isSuppressed(key)) {
        suppressed.delete(key);
        needsEnable.add(key);
        states.delete(key);
        publish();
      }
    }

    for (const [key, server] of current) {
      const previous = observations.get(key);
      const pid = server.pid ?? null;
      const replaced =
        previous !== undefined &&
        previous.present &&
        previous.pid !== null &&
        pid !== null &&
        previous.pid !== pid;
      const reappeared = previous?.present === false;
      if (previous === undefined) {
        observations.set(key, { present: true, pid, lifetime: suppressed.has(key) ? 0 : 1 });
      } else if (replaced || reappeared) {
        observations.set(key, { present: true, pid, lifetime: previous.lifetime + 1 });
        if (suppressed.has(key)) {
          suppressed.delete(key);
          needsEnable.add(key);
          states.delete(key);
          publish();
        }
      } else {
        observations.set(key, { ...previous, present: true, pid });
      }
    }
  };

  const prepare = async (input: PreviewAccessPrepareInput): Promise<PreviewAccessResolution> => {
    const requestedUrl = requestedUrlFor(input.target);
    if (!isLoopbackBrowserNavigationTarget(input.target)) {
      const direct = resolveDirectBrowserNavigationTarget(input.environmentId, input.target);
      return {
        state: "ready",
        transport: "direct",
        requestedUrl,
        cleanUrl: direct.resolvedUrl,
        launchUrl: direct.resolvedUrl,
        resolutionKind: "direct",
        readiness: "ready",
      };
    }

    const environment = dependencies.readEnvironment(input.environmentId);
    if (environment === null)
      throw new Error(`Environment ${input.environmentId} is not connected.`);

    if (dependencies.surface === "desktop") {
      if (isDesktopLocal(environment.connection.target)) {
        const direct = resolveDirectBrowserNavigationTarget(input.environmentId, input.target);
        return {
          state: "ready",
          transport: "direct",
          requestedUrl,
          cleanUrl: direct.resolvedUrl,
          launchUrl: direct.resolvedUrl,
          resolutionKind: "direct",
          readiness: "ready",
        };
      }
      const resolved = await dependencies.prepareDesktop({
        environmentId: input.environmentId,
        target: input.target,
      });
      return {
        state: "ready",
        transport: "desktop-forward",
        requestedUrl,
        cleanUrl: resolved.resolvedUrl,
        launchUrl: resolved.resolvedUrl,
        resolutionKind: resolved.resolutionKind,
        readiness: "ready",
      };
    }

    if (environment.tailnetPreviewPublishing?.protocolVersion !== 1) {
      return { state: "unsupported", requestedUrl, cleanUrl: requestedUrl };
    }
    if (!environment.tailscalePreviewsEnabled) {
      return {
        state: "setup-required",
        requestedUrl,
        cleanUrl: requestedUrl,
        readiness: "disabled",
      };
    }
    const port = portFor(input.target);
    if (port === null) return { state: "unsupported", requestedUrl, cleanUrl: requestedUrl };
    try {
      const result = await acquireFresh({
        environmentId: input.environmentId,
        threadId: input.threadId,
        port,
      });
      if (result.readiness !== "ready") {
        return {
          state: "unavailable",
          requestedUrl,
          cleanUrl: result.cleanUrl,
          readiness: result.readiness,
        };
      }
      return {
        state: "ready",
        transport: "tailnet",
        requestedUrl,
        cleanUrl: result.cleanUrl,
        launchUrl: result.launchUrl,
        resolutionKind: "tailnet-publication",
        readiness: result.readiness,
      };
    } catch (error) {
      const readiness = readinessFromError(error);
      if (readiness === null) throw error;
      return { state: "unavailable", requestedUrl, cleanUrl: requestedUrl, readiness };
    }
  };

  const reconcile = async (input: PreviewAccessReconcileInput) => {
    if (disposed || dependencies.surface !== "web") return;
    observeProcesses(input);
    const environment = dependencies.readEnvironment(input.environmentId);
    if (
      environment?.tailnetPreviewPublishing?.protocolVersion !== 1 ||
      !environment.tailscalePreviewsEnabled
    ) {
      await releaseMatching(input.environmentId, input.threadId);
      return;
    }

    if (input.status === null) {
      await releaseMatching(input.environmentId, input.threadId);
      return;
    }
    const unavailableStatus =
      input.status !== undefined &&
      ("state" in input.status || !input.status.enabled || input.status.readiness !== "ready")
        ? input.status
        : null;
    if (unavailableStatus !== null) {
      await releaseMatching(input.environmentId, input.threadId);
      for (const candidate of input.servers
        .filter((server) => server.terminal?.threadId === input.threadId)
        .slice(0, MAX_AUTOMATIC_PORTS)) {
        const key = keyFor({
          environmentId: input.environmentId,
          threadId: input.threadId,
          port: candidate.port,
        });
        if (isSuppressed(key)) continue;
        setState(key, { state: "unavailable", readiness: unavailableStatus.readiness });
      }
      return;
    }

    const desiredServers = input.servers
      .filter((candidate) => candidate.terminal?.threadId === input.threadId)
      .slice(0, MAX_AUTOMATIC_PORTS);
    const desired = desiredServers.map((candidate) => ({
      environmentId: input.environmentId,
      threadId: input.threadId,
      port: candidate.port,
    }));
    const nextDesiredKeys = new Set(desired.map(keyFor));
    const inScope = (key: string) => {
      const [keyEnvironmentId, keyThreadId] = JSON.parse(key) as [string, string, number];
      return keyEnvironmentId === input.environmentId && keyThreadId === input.threadId;
    };
    for (const key of [...desiredKeys]) {
      if (!inScope(key)) continue;
      if (!nextDesiredKeys.has(key)) {
        desiredKeys.delete(key);
        const lease = leases.get(key);
        const port = lease?.port ?? (JSON.parse(key) as [string, string, number])[2];
        scheduleDisappearance({
          environmentId: input.environmentId,
          threadId: input.threadId,
          port,
        });
      }
    }
    for (const candidate of desired) {
      const key = keyFor(candidate);
      desiredKeys.add(key);
      cancelDisappearance(key);
    }

    await Promise.all(
      desired.map(async (candidate) => {
        const key = keyFor(candidate);
        if (needsEnable.has(key)) {
          await dependencies.tailnet.setPortEnabled({ ...candidate, enabled: true });
          needsEnable.delete(key);
        }
        await ensureLease(candidate);
      }),
    );
  };

  const setPortEnabled = async (input: TailnetOperationInput & { readonly enabled: boolean }) => {
    const key = keyFor(input);
    advanceIntent(key);
    clearDisappearanceTimer(key);
    clearRetryTimer(key);
    retryAttempts.delete(key);
    if (input.enabled) {
      suppressed.delete(key);
      needsEnable.delete(key);
      states.delete(key);
      publish();
      await dependencies.tailnet.setPortEnabled(input);
      return;
    }

    suppressed.set(key, observations.get(key)?.lifetime ?? 0);
    setState(key, { state: "suppressed" });
    const releaseResult = releaseKey(key).catch(() => undefined);
    const settingResult = dependencies.tailnet.setPortEnabled(input);
    await Promise.all([releaseResult, settingResult]);
    setState(key, { state: "suppressed" });
  };

  const cleanup = () => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    disposed = true;
    for (const key of disappearanceTimers.keys()) clearDisappearanceTimer(key);
    for (const key of renewalTimers.keys()) clearRenewalTimer(key);
    for (const key of retryTimers.keys()) clearRetryTimer(key);
    cleanupPromise = (async () => {
      await Promise.allSettled([...pending.values()].map(({ promise }) => promise));
      await Promise.allSettled([...leases.keys()].map(releaseKey));
    })();
    return cleanupPromise;
  };

  return {
    prepare,
    reconcile,
    setPortEnabled,
    getPortState: (input) => states.get(keyFor(input)) ?? { state: "idle" },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cleanup,
  };
}

export function createDefaultPreviewAccessController(): PreviewAccessController {
  return createPreviewAccessController({
    surface:
      typeof window !== "undefined" && window.desktopBridge !== undefined ? "desktop" : "web",
    readEnvironment: (environmentId) => {
      const connection = readPreparedConnection(environmentId);
      if (connection === null) return null;
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
      return {
        connection,
        tailnetPreviewPublishing: config?.environment.capabilities.tailnetPreviewPublishing,
        tailscalePreviewsEnabled: config?.settings.tailscalePreviewsEnabled === true,
      };
    },
    prepareDesktop: ({ environmentId, target }) =>
      prepareBrowserNavigationTarget(environmentId, target),
    tailnet: {
      status: ({ environmentId }) => previewTailnetRpc.status(environmentId),
      acquire: ({ environmentId, threadId, port }) =>
        previewTailnetRpc.acquire(environmentId, { threadId, port }),
      renew: ({ environmentId, threadId, port }) =>
        previewTailnetRpc.renew(environmentId, { threadId, port }),
      release: ({ environmentId, leaseId }) =>
        previewTailnetRpc.release(environmentId, { leaseId }),
      setPortEnabled: ({ environmentId, threadId, port, enabled }) =>
        previewTailnetRpc.setPortEnabled(environmentId, { threadId, port, enabled }),
    },
    timers: {
      setTimeout: (callback, delayMs) =>
        globalThis.setTimeout(() => {
          void callback();
        }, delayMs),
      clearTimeout: (timer) =>
        globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
    },
    now: Date.now,
  });
}
