import type { ScopedThreadRef } from "@t3tools/contracts";
import { type MouseEvent, useMemo, useRef, useState } from "react";

import type { PreviewAccessController } from "~/browser/previewAccessController";
import { readLocalApi } from "~/localApi";
import {
  createPortRowActionExecutor,
  resolvePortRowAction,
} from "~/components/ports/portRowActions";
import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  controller?: PreviewAccessController;
  onOpen: (resolvedUrl: string, requestedUrl: string) => void | Promise<void>;
}

export function PreviewLocalServerCard({ threadRef, server, controller, onOpen }: Props) {
  const subtitle = describeServer(server);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const executor = useMemo(
    () =>
      controller
        ? createPortRowActionExecutor({
            controller,
            openPreview: async (url) => void (await onOpen(url, server.requestedUrl)),
            openExternal: async (url) => {
              const api = readLocalApi();
              if (!api) throw new Error("The browser action is unavailable.");
              await api.shell.openExternal(url);
            },
            copyText: async () => undefined,
          })
        : null,
    [controller, onOpen, server.requestedUrl],
  );

  const handleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    if (!executor) {
      void onOpen(server.requestedUrl, server.requestedUrl);
      return;
    }
    const action = resolvePortRowAction({
      surface: "desktop",
      intent: "row-open",
      platform: typeof navigator === "undefined" ? "" : navigator.platform,
      modifiers: event,
      portState: "idle",
      pending: pendingRef.current,
    });
    if (action.kind === "none") return;
    pendingRef.current = true;
    setPending(true);
    void executor
      .execute({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        port: server.port,
        target: { kind: "url", url: server.requestedUrl },
        action,
      })
      .catch(() => undefined)
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  };

  return (
    <button
      type="button"
      disabled={pending}
      onClick={handleOpen}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
    >
      <PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{subtitle}</span>
        <span className="truncate text-xs text-muted-foreground">
          {server.host}:{server.port}
        </span>
      </span>
    </button>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  return "Listening";
}
