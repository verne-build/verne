import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  BrowserNavigationTarget,
  DesktopPortForwardEnsureResult,
  EnvironmentId,
} from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { prepareBrowserNavigationTargetWith } from "./browserTargetResolver";

interface ActiveForward {
  readonly generation: number;
  readonly leaseId: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly localUrl: string;
}

interface PendingForwardEstablishment {
  readonly generation: number;
  readonly promise: Promise<DesktopPortForwardEnsureResult>;
}

export type PortForwardState =
  | { readonly state: "idle" }
  | { readonly state: "suppressed" }
  | {
      readonly state: "active";
      readonly localPort: number;
      readonly localUrl: string;
    };

const activeForwards = new Map<string, ActiveForward>();
const pendingForwardEstablishments = new Map<string, PendingForwardEstablishment>();
const intentGenerations = new Map<string, number>();
const autoSuppressed = new Set<string>();
const disappearanceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let forwardRevision = 0;
const keyFor = (environmentId: EnvironmentId, port: number) => `${environmentId}\u0000${port}`;
const intentGeneration = (key: string) => intentGenerations.get(key) ?? 0;
const advanceIntentGeneration = (key: string) => {
  const generation = intentGeneration(key) + 1;
  intentGenerations.set(key, generation);
  return generation;
};
const currentActiveForward = (key: string) => {
  const active = activeForwards.get(key);
  return active?.generation === intentGeneration(key) ? active : undefined;
};
const autoForwardStorageKey = (environmentId: EnvironmentId) =>
  `verne.preview.auto-forward.${environmentId}`;
const publish = () => {
  forwardRevision += 1;
  for (const listener of listeners) listener();
};

if (typeof window !== "undefined") {
  window.desktopBridge?.onPortForwardClosed?.((event) => {
    const key = keyFor(event.environmentId, event.remotePort);
    const active = activeForwards.get(key);
    if (active?.leaseId !== event.leaseId) return;
    activeForwards.delete(key);
    publish();
    void releaseServerLease(event.environmentId, active.leaseId);
  });
}

export const subscribePortForwards = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const portForwardSnapshot = () => forwardRevision;

export const isPortForwardActive = (environmentId: EnvironmentId, port: number) =>
  currentActiveForward(keyFor(environmentId, port)) !== undefined;

export const isPortForwardAutoSuppressed = (environmentId: EnvironmentId, port: number) =>
  autoSuppressed.has(keyFor(environmentId, port));

export const readPortForwardState = (
  environmentId: EnvironmentId,
  port: number,
): PortForwardState => {
  const key = keyFor(environmentId, port);
  if (autoSuppressed.has(key)) return { state: "suppressed" };
  const active = currentActiveForward(key);
  return active === undefined
    ? { state: "idle" }
    : { state: "active", localPort: active.localPort, localUrl: active.localUrl };
};

export const isEnvironmentAutoForwardEnabled = (environmentId: EnvironmentId) => {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(autoForwardStorageKey(environmentId)) !== "false";
};

export function setEnvironmentAutoForwardEnabled(environmentId: EnvironmentId, enabled: boolean) {
  window.localStorage.setItem(autoForwardStorageKey(environmentId), String(enabled));
  publish();
  if (!enabled) {
    for (const forward of activeForwards.values()) {
      const key = keyFor(environmentId, forward.remotePort);
      if (activeForwards.get(key) === forward) {
        void disablePortForward(environmentId, forward.remotePort, { suppressAuto: false });
      }
    }
  }
}

export function reconcileDiscoveredPortForwards(
  environmentId: EnvironmentId,
  visiblePorts: ReadonlySet<number>,
) {
  for (const forward of activeForwards.values()) {
    const key = keyFor(environmentId, forward.remotePort);
    if (activeForwards.get(key) !== forward) continue;
    const timer = disappearanceTimers.get(key);
    if (visiblePorts.has(forward.remotePort)) {
      if (timer !== undefined) clearTimeout(timer);
      disappearanceTimers.delete(key);
    } else if (timer === undefined) {
      disappearanceTimers.set(
        key,
        setTimeout(() => {
          disappearanceTimers.delete(key);
          void disablePortForward(environmentId, forward.remotePort, { suppressAuto: false });
        }, 15_000),
      );
    }
  }
}

export async function enablePortForward(environmentId: EnvironmentId, url: string) {
  let port = 0;
  try {
    const parsed = new URL(url);
    port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch {
    // The resolver below reports the useful URL error.
  }
  if (port > 0) {
    const key = keyFor(environmentId, port);
    if (autoSuppressed.delete(key)) {
      advanceIntentGeneration(key);
      publish();
    }
  }
  return prepareBrowserNavigationTarget(environmentId, { kind: "url", url });
}

export async function prepareBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
) {
  return prepareBrowserNavigationTargetWith(environmentId, target, {
    resolveActiveForward: (port) => currentActiveForward(keyFor(environmentId, port)),
    establishDesktopForward: async ({ environmentId, httpBaseUrl, port }) => {
      const key = keyFor(environmentId, port);
      const generation = intentGeneration(key);
      const active = currentActiveForward(key);
      if (active !== undefined) return active;
      const pending = pendingForwardEstablishments.get(key);
      if (pending?.generation === generation) return pending.promise;
      const establishment = (async () => {
        const leaseResult = await runAtomCommand(
          appAtomRegistry,
          previewEnvironment.acquirePortForward,
          { environmentId, input: { port } },
          { label: "preview port forwarding", reportFailure: false },
        );
        if (leaseResult._tag !== "Success") {
          throw new Error(`Could not authorize forwarding for port ${port}.`);
        }
        const ensure = window.desktopBridge?.ensurePortForward;
        if (!ensure) {
          throw new Error(
            "This environment port requires the Verne desktop app's authenticated forwarding support.",
          );
        }
        const local = await ensure({
          environmentId,
          leaseId: leaseResult.value.leaseId,
          httpBaseUrl,
          forwardTicket: leaseResult.value.ticket,
          remotePort: leaseResult.value.port,
        });
        const established: ActiveForward = {
          generation,
          leaseId: leaseResult.value.leaseId,
          remotePort: leaseResult.value.port,
          ...local,
        };
        if (generation !== intentGeneration(key) || autoSuppressed.has(key)) {
          await releaseOwnedForward(environmentId, established);
          throw new Error("Port forward is no longer requested.");
        }
        activeForwards.set(key, established);
        publish();
        return local;
      })();
      const pendingEntry = { generation, promise: establishment };
      pendingForwardEstablishments.set(key, pendingEntry);
      try {
        return await establishment;
      } finally {
        if (pendingForwardEstablishments.get(key) === pendingEntry) {
          pendingForwardEstablishments.delete(key);
        }
      }
    },
  });
}

export async function disablePortForward(
  environmentId: EnvironmentId,
  remotePort: number,
  options: { readonly suppressAuto?: boolean } = { suppressAuto: true },
) {
  const key = keyFor(environmentId, remotePort);
  advanceIntentGeneration(key);
  const timer = disappearanceTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  disappearanceTimers.delete(key);
  if (options.suppressAuto !== false && !autoSuppressed.has(key)) {
    autoSuppressed.add(key);
    publish();
  }
  const active = activeForwards.get(key);
  if (!active) return;
  await releaseOwnedForward(environmentId, active);
  if (activeForwards.get(key) === active) {
    activeForwards.delete(key);
    publish();
  }
}

async function releaseOwnedForward(environmentId: EnvironmentId, active: ActiveForward) {
  await Promise.allSettled([
    window.desktopBridge?.releasePortForward?.({
      environmentId,
      leaseId: active.leaseId,
      remotePort: active.remotePort,
    }),
    releaseServerLease(environmentId, active.leaseId),
  ]);
}

async function releaseServerLease(environmentId: EnvironmentId, leaseId: string) {
  await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.releasePortForward,
    { environmentId, input: { leaseId } },
    { label: "disable preview port forwarding", reportFailure: false },
  );
}
