import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createDefaultPreviewAccessController,
  type PreviewAccessController,
} from "~/browser/previewAccessController";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import {
  enablePortForward,
  isEnvironmentAutoForwardEnabled,
  isPortForwardActive,
  isPortForwardAutoSuppressed,
  reconcileDiscoveredPortForwards,
  portForwardSnapshot,
  subscribePortForwards,
} from "~/browser/prepareBrowserNavigationTarget";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { readPreparedConnection } from "~/state/session";
import { useDiscoveredPortsState } from "~/portDiscoveryState";

export interface PreviewableServer extends DiscoveredLocalServer {
  source: "scanner" | "configured";
  /**
   * Stable pre-resolution loopback URL used for history. The controller owns
   * volatile desktop-forward and Tailnet URLs instead of persisting them here.
   */
  requestedUrl: string;
}

interface UseDiscoveredLocalServersInput {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
}

/**
 * Enrich the environment-level live server snapshot with matching configured
 * URLs and return a stable sorted list.
 */
export function useDiscoveredLocalServers(
  input: UseDiscoveredLocalServersInput,
): ReadonlyArray<PreviewableServer> {
  const scannerState = useDiscoveredPortsState(input.environmentId, input.configuredUrls);

  const servers = useMemo(
    () =>
      mergeServers({
        scanner: scannerState.servers.map((server) => ({
          ...server,
          url: resolveDiscoveredServerUrl(input.environmentId, server.url),
          requestedUrl: server.url,
        })),
        configuredUrls: input.configuredUrls ?? [],
        configuredUrlProbing: scannerState.configuredUrlProbing,
      }),
    [input.environmentId, scannerState, input.configuredUrls],
  );

  return servers;
}

export function useEnvironmentPortForwardLifecycle(environmentId: EnvironmentId, supported = true) {
  const scannerState = useDiscoveredPortsState(environmentId);
  const forwardRevision = useSyncExternalStore(
    subscribePortForwards,
    portForwardSnapshot,
    portForwardSnapshot,
  );
  useEffect(() => {
    if (!supported) return;
    reconcileEnvironmentPortForwards(
      environmentId,
      scannerState.servers.map((server) => ({ ...server, requestedUrl: server.url })),
    );
  }, [environmentId, forwardRevision, scannerState.servers, supported]);
}

/**
 * Owns automatic Tailnet leases for the current thread independently of the
 * selected bottom-drawer tab. Mount this once in the persistent chat lifecycle
 * and share the returned controller with whichever port surface is visible.
 */
export function useThreadPreviewAccessController(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): PreviewAccessController {
  const scannerState = useDiscoveredPortsState(input.environmentId);
  const controller = useMemo(
    () => createDefaultPreviewAccessController(),
    [input.environmentId, input.threadId],
  );

  useEffect(() => {
    if (input.environmentId === null || input.threadId === null) return;
    void controller.reconcile({
      environmentId: input.environmentId,
      threadId: input.threadId,
      servers: scannerState.servers,
    });
  }, [controller, input.environmentId, input.threadId, scannerState.servers]);

  useEffect(() => () => void controller.cleanup(), [controller]);
  return controller;
}

function reconcileEnvironmentPortForwards(
  environmentId: EnvironmentId,
  servers: ReadonlyArray<Pick<PreviewableServer, "port" | "requestedUrl">>,
) {
  if (!window.desktopBridge?.ensurePortForward) return;
  reconcileDiscoveredPortForwards(environmentId, new Set(servers.map((server) => server.port)));
  if (!isEnvironmentAutoForwardEnabled(environmentId)) return;
  const connection = readPreparedConnection(environmentId);
  if (!connection) return;
  if (
    connection.target._tag === "PrimaryConnectionTarget" ||
    isDesktopLocalConnectionTarget(connection.target)
  ) {
    return;
  }
  for (const server of servers.slice(0, 16)) {
    if (
      isPortForwardActive(environmentId, server.port) ||
      isPortForwardAutoSuppressed(environmentId, server.port)
    ) {
      continue;
    }
    void enablePortForward(environmentId, server.requestedUrl).catch(() => undefined);
  }
}

export function mergeServers(input: {
  scanner: ReadonlyArray<DiscoveredLocalServer & { requestedUrl: string }>;
  configuredUrls: ReadonlyArray<string>;
  configuredUrlProbing?: boolean;
}): ReadonlyArray<PreviewableServer> {
  const configuredByServer = new Map<string, { host: string; port: number; url: string }>();

  for (const url of input.configuredUrls) {
    const parsed = parseLocalUrl(url);
    if (!parsed) continue;
    const key = canonicalKey(parsed.host, parsed.port);
    if (!configuredByServer.has(key)) configuredByServer.set(key, parsed);
  }

  const live: PreviewableServer[] = [];
  for (const server of input.scanner) {
    const key = canonicalKey(server.host, server.port);
    const configured = configuredByServer.get(key);
    live.push({
      ...server,
      requestedUrl:
        configured && input.configuredUrlProbing === false ? configured.url : server.requestedUrl,
      source: configured ? "configured" : "scanner",
    });
  }

  return live.toSorted((a, b) => {
    const sourceOrder: Record<PreviewableServer["source"], number> = {
      configured: 0,
      scanner: 1,
    };
    if (sourceOrder[a.source] !== sourceOrder[b.source]) {
      return sourceOrder[a.source] - sourceOrder[b.source];
    }
    return a.port - b.port;
  });
}

function canonicalKey(host: string, port: number): string {
  const normalizedHost = host.toLowerCase();
  return `${isLoopbackHost(normalizedHost) ? "loopback" : normalizedHost}:${port}`;
}

function parseLocalUrl(raw: string): { host: string; port: number; url: string } | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "http:"
        ? 80
        : 443;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: parsed.hostname, port, url: parsed.href };
  } catch {
    return null;
  }
}
