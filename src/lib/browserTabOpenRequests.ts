import type {
  BrowserTabOpenAck,
  BrowserTabOpenCancel,
  BrowserTabOpenRequest,
  BrowserTabOpenResult,
  BrowserTabScope,
} from "@/types";
import {
  openBrowserTabForScope,
  rollbackBrowserTabForScope,
  type FpScope,
} from "@/composables/useFilePanelTabs";

interface BrowserTabOpenDependencies {
  resolveScope: (scope: BrowserTabScope) => Promise<FpScope | null> | FpScope | null;
  activateScope: (scope: FpScope) => Promise<void> | void;
  revealPanel: () => void;
  acknowledge: (ack: BrowserTabOpenAck) => Promise<unknown>;
  openForScope?: typeof openBrowserTabForScope;
  rollbackForScope?: typeof rollbackBrowserTabForScope;
}

interface OpenOutcome {
  request: BrowserTabOpenRequest;
  scope: FpScope;
  result: BrowserTabOpenResult;
}

const MAX_OUTCOMES = 100;

export function installBrowserTabOpenRequests(deps: BrowserTabOpenDependencies): () => void {
  const openForScope = deps.openForScope ?? openBrowserTabForScope;
  const rollbackForScope = deps.rollbackForScope ?? rollbackBrowserTabForScope;
  const inFlight = new Map<string, Promise<OpenOutcome>>();
  const outcomes = new Map<string, OpenOutcome>();
  const requests = new Map<string, BrowserTabOpenRequest>();
  const cancelled = new Set<string>();
  let disposed = false;

  const rememberRequest = (request: BrowserTabOpenRequest): void => {
    const previous = requests.get(request.requestId);
    if (previous) {
      assertSameRequest(previous, request);
      return;
    }
    requests.set(request.requestId, request);
    if (requests.size <= MAX_OUTCOMES) return;
    const staleId = [...requests.keys()].find((requestId) => !inFlight.has(requestId));
    if (!staleId) return;
    requests.delete(staleId);
    outcomes.delete(staleId);
    cancelled.delete(staleId);
  };

  const perform = async (request: BrowserTabOpenRequest): Promise<OpenOutcome> => {
    const requestedScope: BrowserTabScope = {
      path: request.workspaceDir,
      scopeType: request.scopeType,
      scopeId: request.scopeId,
    };
    const scope = await deps.resolveScope(requestedScope);
    if (!scope) {
      throw new Error(`browser scope ${request.scopeType}:${request.scopeId} is not renderable`);
    }
    const result = await openForScope(scope, request.url, {
      newTabId: request.newTabId,
      allowReuse: request.allowReuse,
    });
    try {
      await deps.activateScope(scope);
      deps.revealPanel();
    } catch (error) {
      if (result.created) await rollbackForScope(scope, request.newTabId, request.url);
      throw error;
    }
    return { request, scope, result };
  };

  const outcomeFor = (request: BrowserTabOpenRequest): Promise<OpenOutcome> => {
    rememberRequest(request);
    if (cancelled.has(request.requestId)) {
      return Promise.reject(new Error(`browser tab request ${request.requestId} was cancelled`));
    }
    const complete = outcomes.get(request.requestId);
    if (complete) {
      return Promise.resolve(complete);
    }
    const pending = inFlight.get(request.requestId);
    if (pending) return pending;
    const opening = perform(request).then(async (outcome) => {
      if (cancelled.has(request.requestId)) {
        if (outcome.result.created) {
          await rollbackForScope(outcome.scope, request.newTabId, request.url);
        }
        throw new Error(`browser tab request ${request.requestId} was cancelled`);
      }
      outcomes.set(request.requestId, outcome);
      return outcome;
    }).finally(() => {
      inFlight.delete(request.requestId);
    });
    inFlight.set(request.requestId, opening);
    return opening;
  };

  const onRequest = (event: Event) => {
    const request = (event as CustomEvent<BrowserTabOpenRequest>).detail;
    if (!request) return;
    void (async () => {
      let outcome: OpenOutcome | undefined;
      let ack: BrowserTabOpenAck;
      try {
        outcome = await outcomeFor(request);
        ack = {
          requestId: request.requestId,
          generation: request.generation,
          workspaceDir: request.workspaceDir,
          scopeType: request.scopeType,
          scopeId: request.scopeId,
          ok: true,
          ...outcome.result,
        };
      } catch (error) {
        if (cancelled.has(request.requestId)) return;
        ack = {
          requestId: request.requestId,
          generation: request.generation,
          workspaceDir: request.workspaceDir,
          scopeType: request.scopeType,
          scopeId: request.scopeId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (disposed) return;
      try {
        await deps.acknowledge(ack);
      } catch (error) {
        if (outcome?.result.created) {
          await rollbackForScope(outcome.scope, request.newTabId, request.url);
          outcomes.delete(request.requestId);
        }
        console.error("[browser-tab-open] acknowledgement failed:", error);
      }
    })();
  };

  const onCancel = (event: Event) => {
    const request = (event as CustomEvent<BrowserTabOpenCancel>).detail;
    if (!request) return;
    try {
      rememberRequest(request);
    } catch (error) {
      console.error("[browser-tab-open] invalid cancellation:", error);
      return;
    }
    if (cancelled.has(request.requestId)) return;
    cancelled.add(request.requestId);
    const pending = inFlight.get(request.requestId);
    void (async () => {
      let outcome = outcomes.get(request.requestId);
      if (!outcome && pending) {
        try {
          outcome = await pending;
        } catch {
          // A failed/cancelled open has no owned tab to remove.
        }
      }
      if (outcome?.result.created) {
        await rollbackForScope(outcome.scope, request.newTabId, request.url);
      } else if (!outcome && !pending) {
        const scope = await deps.resolveScope({
          path: request.workspaceDir,
          scopeType: request.scopeType,
          scopeId: request.scopeId,
        });
        if (scope) await rollbackForScope(scope, request.newTabId, request.url);
      }
      outcomes.delete(request.requestId);
    })();
  };

  window.addEventListener("browser-tab-open-request", onRequest);
  window.addEventListener("browser-tab-open-cancel", onCancel);
  return () => {
    disposed = true;
    window.removeEventListener("browser-tab-open-request", onRequest);
    window.removeEventListener("browser-tab-open-cancel", onCancel);
  };
}

function assertSameRequest(previous: BrowserTabOpenRequest, next: BrowserTabOpenRequest): void {
  if (
    previous.newTabId !== next.newTabId
    || previous.url !== next.url
    || previous.workspaceDir !== next.workspaceDir
    || previous.scopeType !== next.scopeType
    || previous.scopeId !== next.scopeId
    || previous.source !== next.source
    || previous.allowReuse !== next.allowReuse
  ) throw new Error(`browser tab request id ${next.requestId} was reused with different parameters`);
}
