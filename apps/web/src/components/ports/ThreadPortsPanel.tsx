import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import { Copy, ExternalLink, Power } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { PreviewAccessController } from "~/browser/previewAccessController";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import {
  disablePortForward,
  enablePortForward,
  portForwardSnapshot,
  readPortForwardState,
  subscribePortForwards,
} from "~/browser/prepareBrowserNavigationTarget";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { useThreadDiscoveredPorts } from "~/portDiscoveryState";
import { useServerConfigs } from "~/state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  createPortRowActionExecutor,
  type PortRowOperationIssue,
  type PortRowIntent,
  resolvePortRowAccessState,
  resolvePortRowAction,
  resolvePortRowPresentation,
} from "./portRowActions";

const DISAPPEARANCE_GRACE_MS = 15_000;
const MAX_PUBLISHED_PORTS = 16;

interface ThreadPortsPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly controller: PreviewAccessController;
  readonly openPreview: OpenPreviewMutation;
}

interface RetainedPort {
  readonly server: DiscoveredLocalServer;
  readonly present: boolean;
}

export function ThreadPortsPanel({ threadRef, controller, openPreview }: ThreadPortsPanelProps) {
  const discovered = useThreadDiscoveredPorts(threadRef);
  const [retained, setRetained] = useState<ReadonlyMap<number, DiscoveredLocalServer>>(
    () => new Map(discovered.map((server) => [server.port, server])),
  );
  const disappearanceTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const currentPorts = new Set(discovered.map((server) => server.port));
    setRetained((current) => {
      const next = new Map(current);
      for (const server of discovered) next.set(server.port, server);
      for (const port of current.keys()) {
        if (currentPorts.has(port) || disappearanceTimers.current.has(port)) continue;
        const timer = setTimeout(() => {
          disappearanceTimers.current.delete(port);
          setRetained((latest) => {
            const nextLatest = new Map(latest);
            nextLatest.delete(port);
            return nextLatest;
          });
        }, DISAPPEARANCE_GRACE_MS);
        disappearanceTimers.current.set(port, timer);
      }
      return next;
    });

    for (const port of currentPorts) {
      const timer = disappearanceTimers.current.get(port);
      if (timer !== undefined) clearTimeout(timer);
      disappearanceTimers.current.delete(port);
    }
  }, [discovered]);

  useEffect(
    () => () => {
      for (const timer of disappearanceTimers.current.values()) clearTimeout(timer);
      disappearanceTimers.current.clear();
    },
    [],
  );

  const currentPorts = useMemo(
    () => new Set(discovered.map((server) => server.port)),
    [discovered],
  );
  const automaticallyPublishedPorts = useMemo(
    () => new Set(discovered.slice(0, MAX_PUBLISHED_PORTS).map((server) => server.port)),
    [discovered],
  );
  const rows = useMemo<ReadonlyArray<RetainedPort>>(
    () =>
      [...retained.values()]
        .map((server) => ({ server, present: currentPorts.has(server.port) }))
        .toSorted((left, right) => left.server.port - right.server.port),
    [currentPorts, retained],
  );
  const serverConfigs = useServerConfigs();
  const serverConfig = serverConfigs.get(threadRef.environmentId);
  const surface =
    typeof window !== "undefined" && window.desktopBridge !== undefined ? "desktop" : "web";
  const supportsTailnet =
    serverConfig?.environment.capabilities.tailnetPreviewPublishing?.protocolVersion === 1;
  const tailnetEnabled = serverConfig?.settings.tailscalePreviewsEnabled === true;

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <p className="text-sm font-medium text-foreground">No ports for this thread</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Start a development server in this thread’s terminal. Only listeners attributed to this
            thread appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
        {surface === "web" ? (
          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Open these URLs from a browser device connected to the same Tailnet and allowed by its
            ACL.
          </p>
        ) : null}
        <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-background">
          {rows.map((row) => (
            <ThreadPortRow
              key={row.server.port}
              threadRef={threadRef}
              server={row.server}
              present={row.present}
              overCapacity={
                surface === "web" &&
                row.present &&
                !automaticallyPublishedPorts.has(row.server.port)
              }
              surface={surface}
              supportsTailnet={supportsTailnet}
              tailnetEnabled={tailnetEnabled}
              controller={controller}
              openPreview={openPreview}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface ThreadPortRowProps extends ThreadPortsPanelProps {
  readonly server: DiscoveredLocalServer;
  readonly present: boolean;
  readonly overCapacity: boolean;
  readonly surface: "desktop" | "web";
  readonly supportsTailnet: boolean;
  readonly tailnetEnabled: boolean;
}

function ThreadPortRow({
  threadRef,
  server,
  present,
  overCapacity,
  surface,
  supportsTailnet,
  tailnetEnabled,
  controller,
  openPreview,
}: ThreadPortRowProps) {
  const scope = useMemo(
    () => ({
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      port: server.port,
    }),
    [server.port, threadRef.environmentId, threadRef.threadId],
  );
  const stateSnapshot = useSyncExternalStore(
    controller.subscribe,
    () => previewAccessStateSnapshot(controller, scope),
    () => "idle",
  );
  const accessState = controller.getPortState(scope);
  void stateSnapshot;
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [lastCleanUrl, setLastCleanUrl] = useState<string | null>(null);
  const [operationIssue, setOperationIssue] = useState<PortRowOperationIssue | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const executor = useMemo(
    () =>
      createPortRowActionExecutor({
        controller,
        setPortEnabled: async (input) => {
          if (surface === "web") {
            await controller.setPortEnabled(input);
          } else if (input.enabled) {
            await enablePortForward(threadRef.environmentId, server.url);
          } else {
            await disablePortForward(threadRef.environmentId, server.port);
          }
        },
        openPreview: async (url) => {
          const result = await openUrlInPreview({ threadRef, url, openPreview });
          if (result._tag !== "Success") throw new Error("The Verne Preview could not be opened.");
        },
        openExternal: async (url) => {
          const api = readLocalApi();
          if (!api) throw new Error("The browser action is unavailable.");
          await api.shell.openExternal(url);
        },
        copyText: async (url) => {
          if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
            throw new Error("Clipboard access is unavailable.");
          }
          await navigator.clipboard.writeText(url);
        },
      }),
    [controller, openPreview, server.port, server.url, surface, threadRef],
  );

  const forwardSnapshot = useSyncExternalStore(
    subscribePortForwards,
    portForwardSnapshot,
    portForwardSnapshot,
  );
  const presentedAccessState = resolvePortRowAccessState({
    surface,
    controllerState: accessState,
    desktopForwardState: readPortForwardState(threadRef.environmentId, server.port),
  });
  useEffect(() => {
    setActionError(null);
    setOperationIssue(null);
  }, [forwardSnapshot, stateSnapshot]);
  const presentation = resolvePortRowPresentation({
    accessState: presentedAccessState,
    present,
    overCapacity,
    surface,
    supportsTailnet,
    tailnetEnabled,
    operationIssue,
  });
  const displayUrl =
    presentedAccessState.state === "active" || presentedAccessState.state === "disappearing"
      ? presentedAccessState.cleanUrl
      : (lastCleanUrl ?? (presentation.state === "publishing" ? null : server.url));
  const actionsDisabled = pending || !present || presentation.state === "suppressed";

  const run = useCallback(
    async (
      intent: PortRowIntent,
      modifiers: { readonly metaKey: boolean; readonly ctrlKey: boolean },
    ) => {
      if (pendingRef.current) return;
      const action = resolvePortRowAction({
        surface,
        intent,
        platform: typeof navigator === "undefined" ? "" : navigator.platform,
        modifiers,
        portState: presentation.state,
        pending: pendingRef.current,
      });
      if (action.kind === "none") return;
      pendingRef.current = true;
      setPending(true);
      setActionError(null);
      try {
        const outcome = await executor.execute({
          ...scope,
          target: { kind: "url", url: server.url },
          action,
        });
        if (outcome.status === "completed" && outcome.cleanUrl) {
          setLastCleanUrl(outcome.cleanUrl);
          setOperationIssue(null);
        } else if (outcome.status === "unavailable") {
          setLastCleanUrl(outcome.cleanUrl);
          if (outcome.resolution.state === "unsupported") {
            setOperationIssue({ state: "unsupported" });
          } else if (outcome.resolution.state === "setup-required") {
            setOperationIssue({ state: "setup-required", readiness: "disabled" });
          } else {
            setOperationIssue({
              state: "unavailable",
              readiness: outcome.resolution.readiness,
            });
          }
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "The port action failed.");
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [executor, presentation.state, scope, server.url, surface],
  );

  const handleRowClick = (event: MouseEvent<HTMLButtonElement>) => {
    void run("row-open", event);
  };

  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
      <button
        type="button"
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        disabled={actionsDisabled}
        onClick={handleRowClick}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              presentation.state === "active"
                ? "bg-emerald-500"
                : presentation.state === "unavailable" || !present
                  ? "bg-destructive"
                  : "bg-muted-foreground/60",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {server.processName ?? "Listening"}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                :{server.port}
              </span>
            </span>
            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
              {displayUrl ?? "Resolving preview URL…"}
            </span>
          </span>
        </span>
      </button>

      <div className="hidden min-w-40 max-w-72 flex-col text-right sm:flex">
        <span className="text-xs font-medium text-foreground">
          {pending ? "Working…" : presentation.status}
        </span>
        <span className="text-[11px] leading-4 text-muted-foreground">
          {actionError ?? presentation.description}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Copy launch URL for port ${server.port}`}
                disabled={actionsDisabled}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                onClick={() => void run("copy", { metaKey: false, ctrlKey: false })}
              />
            }
          >
            <Copy className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Copy fresh launch URL</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open port ${server.port} in browser`}
                disabled={actionsDisabled}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                onClick={() => void run("browser-open", { metaKey: false, ctrlKey: false })}
              />
            }
          >
            <ExternalLink className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open in browser</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${presentation.state === "suppressed" ? "Enable" : "Disable"} port ${server.port}`}
                disabled={
                  pending ||
                  !present ||
                  (surface === "web" && (overCapacity || !supportsTailnet || !tailnetEnabled))
                }
                className={cn(
                  "rounded-md p-1.5 hover:bg-accent disabled:opacity-40",
                  presentation.state === "suppressed"
                    ? "text-muted-foreground"
                    : "text-emerald-500",
                )}
                onClick={() => void run("toggle", { metaKey: false, ctrlKey: false })}
              />
            }
          >
            <Power className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {presentation.state === "suppressed" ? "Enable port" : "Disable port"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function previewAccessStateSnapshot(
  controller: PreviewAccessController,
  input: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly threadId: ScopedThreadRef["threadId"];
    readonly port: number;
  },
): string {
  const state = controller.getPortState(input);
  if (state.state === "active" || state.state === "disappearing") {
    return `${state.state}:${state.cleanUrl}:${state.expiresAt}`;
  }
  return state.state === "unavailable" ? `${state.state}:${state.readiness}` : state.state;
}
