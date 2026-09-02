import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { prepareBrowserNavigationTargetWith } from "./browserTargetResolver";

interface ActiveForward {
  readonly leaseId: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly localUrl: string;
}

const activeForwards = new Map<string, ActiveForward>();
const pendingForwards = new Map<string, Promise<PreviewUrlResolution>>();
const autoSuppressed = new Set<string>();
const disappearanceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let forwardRevision = 0;
const keyFor = (environmentId: EnvironmentId, port: number) => `${environmentId}\u0000${port}`;
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
  activeForwards.has(keyFor(environmentId, port));

export const isPortForwardAutoSuppressed = (environmentId: EnvironmentId, port: number) =>
  autoSuppressed.has(keyFor(environmentId, port));

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
  if (port > 0) autoSuppressed.delete(keyFor(environmentId, port));
  return prepareBrowserNavigationTarget(environmentId, { kind: "url", url });
}

export async function prepareBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
) {
  const port = targetPort(target);
  const key = port === null ? null : keyFor(environmentId, port);
  const pending = key === null ? undefined : pendingForwards.get(key);
  if (pending) return pending;

  const preparation = prepareBrowserNavigationTargetWith(environmentId, target, {
    resolveActiveForward: (port) => activeForwards.get(keyFor(environmentId, port)),
    acquireLease: async (port) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.acquirePortForward,
        { environmentId, input: { port } },
        { label: "preview port forwarding", reportFailure: false },
      );
      if (result._tag !== "Success") {
        throw new Error(`Could not authorize forwarding for port ${port}.`);
      }
      return result.value;
    },
    ensureDesktopForward: async ({ environmentId, httpBaseUrl, lease }) => {
      const ensure = window.desktopBridge?.ensurePortForward;
      if (!ensure) {
        throw new Error(
          "This environment port requires the Verne desktop app's authenticated forwarding support.",
        );
      }
      const result = await ensure({
        environmentId,
        leaseId: lease.leaseId,
        httpBaseUrl,
        forwardTicket: lease.ticket,
        remotePort: lease.port,
      });
      activeForwards.set(keyFor(environmentId, lease.port), {
        leaseId: lease.leaseId,
        remotePort: lease.port,
        ...result,
      });
      publish();
      return result;
    },
  });
  if (key === null) return preparation;
  pendingForwards.set(key, preparation);
  try {
    return await preparation;
  } finally {
    if (pendingForwards.get(key) === preparation) pendingForwards.delete(key);
  }
}

function targetPort(target: BrowserNavigationTarget): number | null {
  if (target.kind === "environment-port") return target.port;
  try {
    const url = new URL(target.url.includes("://") ? target.url : `http://${target.url}`);
    if (!isLoopbackHost(url.hostname)) return null;
    return Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

export async function disablePortForward(
  environmentId: EnvironmentId,
  remotePort: number,
  options: { readonly suppressAuto?: boolean } = { suppressAuto: true },
) {
  const key = keyFor(environmentId, remotePort);
  const timer = disappearanceTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  disappearanceTimers.delete(key);
  if (options.suppressAuto !== false) autoSuppressed.add(key);
  const active = activeForwards.get(key);
  if (!active) return;
  await window.desktopBridge?.releasePortForward?.({ environmentId, remotePort });
  await releaseServerLease(environmentId, active.leaseId);
  activeForwards.delete(key);
  publish();
}

async function releaseServerLease(environmentId: EnvironmentId, leaseId: string) {
  await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.releasePortForward,
    { environmentId, input: { leaseId } },
    { label: "disable preview port forwarding", reportFailure: false },
  );
}
