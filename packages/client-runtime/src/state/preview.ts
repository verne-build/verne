import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const previewAutomationHostFocusConcurrencyKey = (value: {
  readonly environmentId: string;
  readonly input: {
    readonly clientId: string;
    readonly connectionId: string;
  };
}): string => JSON.stringify([value.environmentId, value.input.clientId, value.input.connectionId]);

export function createPreviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const statusScheduler = createAtomCommandScheduler();
  const automationScheduler = createAtomCommandScheduler();
  const tailnetScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:list",
      tag: WS_METHODS.previewList,
      staleTimeMs: 5_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:events",
      tag: WS_METHODS.subscribePreviewEvents,
    }),
    discoveredServers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:discovered-servers",
      tag: WS_METHODS.subscribeDiscoveredLocalServers,
      // Configured URLs are part of this atom's key. Dispose immediately so
      // unmounted projects stop contributing probe candidates on the server.
      idleTtlMs: 0,
    }),
    tailnetStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:tailnet-status",
      tag: WS_METHODS.previewTailnetStatus,
      staleTimeMs: 5_000,
    }),
    acquireTailnetPreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:tailnet-acquire",
      tag: WS_METHODS.previewTailnetAcquire,
      scheduler: tailnetScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.port]),
      },
    }),
    renewTailnetPreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:tailnet-renew",
      tag: WS_METHODS.previewTailnetRenew,
      scheduler: tailnetScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.port]),
      },
    }),
    releaseTailnetPreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:tailnet-release",
      tag: WS_METHODS.previewTailnetRelease,
      scheduler: tailnetScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.leaseId]),
      },
    }),
    setTailnetPreviewPortEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:tailnet-set-port-enabled",
      tag: WS_METHODS.previewTailnetSetPortEnabled,
      scheduler: tailnetScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.port]),
      },
    }),
    acquirePortForward: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:port-forward-acquire",
      tag: WS_METHODS.previewPortForwardAcquire,
    }),
    releasePortForward: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:port-forward-release",
      tag: WS_METHODS.previewPortForwardRelease,
    }),
    automationRequests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:automation-requests",
      tag: WS_METHODS.previewAutomationConnect,
      // Automation requests are commands, not cached query data. Dispose the
      // stream immediately with its owner so stale requests cannot replay when
      // a thread remounts and the server can clear disconnected hosts promptly.
      idleTtlMs: 0,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:open",
      tag: WS_METHODS.previewOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:navigate",
      tag: WS_METHODS.previewNavigate,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:resize",
      tag: WS_METHODS.previewResize,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:refresh",
      tag: WS_METHODS.previewRefresh,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:close",
      tag: WS_METHODS.previewClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    reportStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:report-status",
      tag: WS_METHODS.previewReportStatus,
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
    respondToAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-respond",
      tag: WS_METHODS.previewAutomationRespond,
      scheduler: automationScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.connectionId, input.requestId]),
      },
    }),
    focusAutomationHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-focus-host",
      tag: WS_METHODS.previewAutomationFocusHost,
      scheduler: automationScheduler,
      concurrency: {
        mode: "latest",
        key: previewAutomationHostFocusConcurrencyKey,
      },
    }),
  };
}
