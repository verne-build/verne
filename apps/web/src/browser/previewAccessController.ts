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

export interface PreviewAccessReconcileInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
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

export function createPreviewAccessController(
  dependencies: PreviewAccessControllerDependencies,
): PreviewAccessController {
  const leases = new Map<string, OwnedLease>();
  const states = new Map<string, PreviewAccessPortState>();
  const pending = new Map<string, Promise<PreviewTailnetAcquireResult>>();
  const disappearanceTimers = new Map<string, unknown>();
  const renewalTimers = new Map<string, unknown>();
  const suppressed = new Set<string>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let cleanupPromise: Promise<void> | undefined;

  const publish = () => {
    for (const listener of listeners) listener();
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

  const clearRenewalTimer = (key: string) => {
    const timer = renewalTimers.get(key);
    if (timer !== undefined) dependencies.timers.clearTimeout(timer);
    renewalTimers.delete(key);
  };

  let ensureLease!: (input: TailnetOperationInput) => Promise<void>;

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

  const remember = (input: TailnetOperationInput, result: PreviewTailnetAcquireResult) => {
    const key = keyFor(input);
    leases.set(key, {
      ...input,
      leaseId: result.leaseId,
      cleanUrl: result.cleanUrl,
      expiresAt: result.expiresAt,
    });
    setState(key, {
      state: "active",
      cleanUrl: result.cleanUrl,
      expiresAt: result.expiresAt,
    });
    scheduleRenewal(input, result.expiresAt);
  };

  const singleFlight = (
    input: TailnetOperationInput,
    operation: () => Promise<PreviewTailnetAcquireResult>,
  ): Promise<PreviewTailnetAcquireResult> => {
    const key = keyFor(input);
    const active = pending.get(key);
    if (active !== undefined) return active;
    const current = operation();
    pending.set(key, current);
    void current.then(
      () => {
        if (pending.get(key) === current) pending.delete(key);
      },
      () => {
        if (pending.get(key) === current) pending.delete(key);
      },
    );
    return current;
  };

  const acquireFresh = async (input: TailnetOperationInput) => {
    if (disposed) throw new Error("This preview access controller has been disposed.");
    const result = await singleFlight(input, () => dependencies.tailnet.acquire(input));
    remember(input, result);
    return result;
  };

  ensureLease = async (input: TailnetOperationInput) => {
    if (disposed || suppressed.has(keyFor(input))) return;
    try {
      const result = await singleFlight(input, () =>
        leases.has(keyFor(input))
          ? dependencies.tailnet.renew(input)
          : dependencies.tailnet.acquire(input),
      );
      if (disposed || suppressed.has(keyFor(input))) {
        await dependencies.tailnet
          .release({
            environmentId: input.environmentId,
            leaseId: result.leaseId,
          })
          .catch(() => undefined);
        return;
      }
      remember(input, result);
    } catch (error) {
      const readiness = readinessFromError(error);
      if (readiness !== null) setState(keyFor(input), { state: "unavailable", readiness });
    }
  };

  const releaseKey = async (key: string) => {
    clearDisappearanceTimer(key);
    clearRenewalTimer(key);
    const lease = leases.get(key);
    leases.delete(key);
    if (!suppressed.has(key)) states.delete(key);
    if (lease === undefined) return;
    publish();
    await dependencies.tailnet.release({
      environmentId: lease.environmentId,
      leaseId: lease.leaseId,
    });
  };

  const releaseMatching = async (environmentId: EnvironmentId, threadId: ThreadId) => {
    await Promise.allSettled(
      [...leases.entries()]
        .filter(([, lease]) => lease.environmentId === environmentId && lease.threadId === threadId)
        .map(([key]) => releaseKey(key)),
    );
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
    const environment = dependencies.readEnvironment(input.environmentId);
    if (
      environment?.tailnetPreviewPublishing?.protocolVersion !== 1 ||
      !environment.tailscalePreviewsEnabled
    ) {
      await releaseMatching(input.environmentId, input.threadId);
      return;
    }

    const desired = input.servers
      .filter((candidate) => candidate.terminal?.threadId === input.threadId)
      .slice(0, MAX_AUTOMATIC_PORTS)
      .map((candidate) => ({
        environmentId: input.environmentId,
        threadId: input.threadId,
        port: candidate.port,
      }));
    const desiredKeys = new Set(desired.map(keyFor));
    for (const candidate of desired) clearDisappearanceTimer(keyFor(candidate));

    for (const [key, lease] of leases) {
      if (
        lease.environmentId !== input.environmentId ||
        lease.threadId !== input.threadId ||
        desiredKeys.has(key) ||
        disappearanceTimers.has(key)
      ) {
        continue;
      }
      setState(key, {
        state: "disappearing",
        cleanUrl: lease.cleanUrl,
        expiresAt: lease.expiresAt,
      });
      clearRenewalTimer(key);
      const timer = dependencies.timers.setTimeout(async () => {
        disappearanceTimers.delete(key);
        await releaseKey(key).catch(() => undefined);
      }, DISAPPEARANCE_GRACE_MS);
      disappearanceTimers.set(key, timer);
    }

    await Promise.all(desired.map(ensureLease));
  };

  const setPortEnabled = async (input: TailnetOperationInput & { readonly enabled: boolean }) => {
    const key = keyFor(input);
    clearDisappearanceTimer(key);
    if (input.enabled) {
      suppressed.delete(key);
      states.delete(key);
      publish();
      await dependencies.tailnet.setPortEnabled(input);
      return;
    }

    suppressed.add(key);
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
    cleanupPromise = (async () => {
      await Promise.allSettled([...pending.values()]);
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
