import type {
  BrowserTabOpenAck,
  BrowserTabOpenRequest,
  FilePanelTab,
} from "@/types";

interface ActiveScope {
  path: string;
  scopeType: "directory" | "agent_worktree";
  scopeId: string;
}

interface BrowserTabOpenDependencies {
  activeScope: () => ActiveScope | null;
  tabs: () => readonly FilePanelTab[];
  openBrowserTab: (url: string, label?: string, id?: string) => string;
  setActiveId: (id: string) => void;
  revealPanel: () => void;
  acknowledge: (ack: BrowserTabOpenAck) => Promise<unknown>;
}

export function installBrowserTabOpenRequests(deps: BrowserTabOpenDependencies): () => void {
  const onRequest = (event: Event) => {
    const request = (event as CustomEvent<BrowserTabOpenRequest>).detail;
    if (!request) return;
    void handleRequest(request, deps);
  };
  window.addEventListener("browser-tab-open-request", onRequest);
  return () => window.removeEventListener("browser-tab-open-request", onRequest);
}

async function handleRequest(
  request: BrowserTabOpenRequest,
  deps: BrowserTabOpenDependencies,
): Promise<void> {
  const ack: BrowserTabOpenAck = {
    requestId: request.requestId,
    tabId: request.tabId,
    workspaceDir: request.workspaceDir,
    ok: false,
  };
  try {
    const scope = deps.activeScope();
    if (!scope || scope.path !== request.workspaceDir) {
      throw new Error(`workspace ${request.workspaceDir} is not active`);
    }

    deps.revealPanel();
    const existing = deps.tabs().find((tab) => tab.id === request.tabId);
    if (existing) {
      if (existing.kind !== "browser") throw new Error(`tab id ${request.tabId} is already in use`);
      deps.setActiveId(existing.id);
    } else {
      if (request.focusExisting) throw new Error(`visible browser tab ${request.tabId} is no longer open`);
      const openedId = deps.openBrowserTab(request.url, undefined, request.tabId);
      if (openedId !== request.tabId) throw new Error(`could not reserve browser tab id ${request.tabId}`);
    }
    ack.ok = true;
  } catch (error) {
    ack.error = error instanceof Error ? error.message : String(error);
  }

  try {
    await deps.acknowledge(ack);
  } catch (error) {
    console.error("[browser-tab-open] acknowledgement failed:", error);
  }
}
