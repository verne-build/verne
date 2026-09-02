import type {
  BrowserNavigationTarget,
  EnvironmentId,
  TailnetPreviewReadiness,
  ThreadId,
} from "@t3tools/contracts";

import type {
  PreviewAccessController,
  PreviewAccessPortState,
  PreviewAccessResolution,
} from "~/browser/previewAccessController";
import type { PortForwardState } from "~/browser/prepareBrowserNavigationTarget";
import { isMacPlatform } from "~/lib/utils";

export type PortRowSurface = "desktop" | "web";
export type PortRowIntent = "row-open" | "browser-open" | "copy" | "toggle";
export type PortRowPresentationState =
  | "idle"
  | "publishing"
  | "active"
  | "suppressed"
  | "disappearing"
  | "setup-required"
  | "unavailable";

export type PortRowAction =
  | { readonly kind: "none" }
  | { readonly kind: "prepare"; readonly destination: "preview" | "external" | "copy" }
  | { readonly kind: "set-enabled"; readonly enabled: boolean };

interface ResolvePortRowActionInput {
  readonly surface: PortRowSurface;
  readonly intent: PortRowIntent;
  readonly platform: string;
  readonly modifiers: { readonly metaKey: boolean; readonly ctrlKey: boolean };
  readonly portState: PortRowPresentationState;
  readonly pending: boolean;
}

export function resolvePortRowAction(input: ResolvePortRowActionInput): PortRowAction {
  if (input.pending) return { kind: "none" };
  if (input.intent === "toggle") {
    return { kind: "set-enabled", enabled: input.portState === "suppressed" };
  }
  if (input.intent === "copy") return { kind: "prepare", destination: "copy" };
  if (input.surface === "web" || input.intent === "browser-open") {
    return { kind: "prepare", destination: "external" };
  }
  const modified = isMacPlatform(input.platform)
    ? input.modifiers.metaKey
    : input.modifiers.ctrlKey;
  return { kind: "prepare", destination: modified ? "external" : "preview" };
}

export interface PortReadinessDescription {
  readonly status: string;
  readonly description: string;
}

export type PortRowOperationIssue =
  | { readonly state: "unsupported" }
  | { readonly state: "setup-required"; readonly readiness: "disabled" }
  | { readonly state: "unavailable"; readonly readiness: TailnetPreviewReadiness };

export function resolvePortRowAccessState(input: {
  readonly surface: PortRowSurface;
  readonly controllerState: PreviewAccessPortState;
  readonly desktopForwardState: PortForwardState;
}): PreviewAccessPortState {
  if (input.surface !== "desktop") return input.controllerState;
  switch (input.desktopForwardState.state) {
    case "suppressed":
      return { state: "suppressed" };
    case "active":
      return {
        state: "active",
        cleanUrl: input.desktopForwardState.localUrl,
        expiresAt: "",
      };
    case "idle":
      return input.controllerState;
  }
}

export function describePortReadiness(
  readiness: TailnetPreviewReadiness,
): PortReadinessDescription {
  switch (readiness) {
    case "ready":
      return { status: "Active", description: "This port is ready to open." };
    case "disabled":
      return {
        status: "Setup required",
        description: "Set up Tailnet previews in Settings → Connections.",
      };
    case "tailscale-unavailable":
      return {
        status: "Unavailable",
        description: "Install and start Tailscale on the environment.",
      };
    case "not-logged-in":
      return {
        status: "Setup required",
        description: "Sign in to Tailscale on the environment.",
      };
    case "magic-dns-unavailable":
      return {
        status: "Setup required",
        description: "Enable MagicDNS for the tailnet.",
      };
    case "https-unavailable":
      return {
        status: "Setup required",
        description: "Enable Tailscale HTTPS for the tailnet.",
      };
    case "permission-denied":
      return {
        status: "Permission required",
        description:
          "On Linux, an operator can grant the Verne account permission with `sudo tailscale set --operator=<user>`. Verne never runs sudo.",
      };
    case "mapping-conflict":
      return {
        status: "Port conflict",
        description:
          "This Tailnet port is mapped to another target. Verne left that mapping unchanged.",
      };
    case "gateway-failed":
      return {
        status: "Unavailable",
        description: "Verne could not start or reach the preview gateway. Retry the port.",
      };
    case "capacity-reached":
      return {
        status: "Capacity reached",
        description: "This environment has reached its 16-port preview capacity.",
      };
  }
}

export function resolvePortRowPresentation(input: {
  readonly accessState: PreviewAccessPortState;
  readonly present: boolean;
  readonly overCapacity: boolean;
  readonly surface: PortRowSurface;
  readonly supportsTailnet: boolean;
  readonly tailnetEnabled: boolean;
  readonly operationIssue: PortRowOperationIssue | null;
}): {
  readonly state: PortRowPresentationState;
  readonly status: string;
  readonly description: string;
} {
  if (!input.present || input.accessState.state === "disappearing") {
    return {
      state: "disappearing",
      status: "Closed",
      description: "The listener disappeared; access closes after the restart grace period.",
    };
  }
  if (input.accessState.state === "suppressed") {
    return {
      state: "suppressed",
      status: "Disabled",
      description: "Enable this port to publish it again.",
    };
  }
  if (input.accessState.state === "active") {
    return input.surface === "web"
      ? {
          state: "active",
          status: "Active",
          description: "Open from a browser device on the same Tailnet and allowed by its ACL.",
        }
      : {
          state: "active",
          status: "Active",
          description: "Forwarded to localhost on this device.",
        };
  }
  const readiness = input.overCapacity
    ? "capacity-reached"
    : input.accessState.state === "unavailable"
      ? input.accessState.readiness
      : input.operationIssue?.state === "setup-required" ||
          input.operationIssue?.state === "unavailable"
        ? input.operationIssue.readiness
        : null;
  if (readiness !== null) {
    const description = describePortReadiness(readiness);
    return {
      state:
        description.status === "Setup required" || description.status === "Permission required"
          ? "setup-required"
          : "unavailable",
      ...description,
    };
  }
  if (input.operationIssue?.state === "unsupported") {
    return {
      state: "unavailable",
      status: "Update required",
      description: "Update this environment’s Verne server to use Tailnet previews.",
    };
  }
  if (input.surface === "web" && !input.supportsTailnet) {
    return {
      state: "unavailable",
      status: "Unavailable",
      description: "Update this environment’s Verne server to use Tailnet previews.",
    };
  }
  if (input.surface === "web" && !input.tailnetEnabled) {
    return { state: "setup-required", ...describePortReadiness("disabled") };
  }
  if (input.surface === "web") {
    return {
      state: "publishing",
      status: "Publishing",
      description: "Preparing a Tailnet preview URL.",
    };
  }
  return { state: "idle", status: "Ready", description: "Opens through localhost on this device." };
}

interface ExecutePortRowActionInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly port: number;
  readonly target: BrowserNavigationTarget;
  readonly action: PortRowAction;
}

export type PortRowActionOutcome =
  | { readonly status: "skipped" }
  | { readonly status: "completed"; readonly cleanUrl?: string }
  | {
      readonly status: "unavailable";
      readonly cleanUrl: string;
      readonly resolution: Exclude<PreviewAccessResolution, { readonly state: "ready" }>;
    };

interface PortRowActionExecutorDependencies {
  readonly controller: Pick<PreviewAccessController, "prepare" | "setPortEnabled">;
  readonly setPortEnabled?: PreviewAccessController["setPortEnabled"];
  readonly reserveExternal?: () => {
    readonly navigate: (url: string) => Promise<void>;
    readonly close: () => void;
  };
  readonly openPreview: (url: string) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly copyText: (text: string) => Promise<void>;
}

export interface PortRowActionExecutor {
  readonly execute: (input: ExecutePortRowActionInput) => Promise<PortRowActionOutcome>;
  readonly isPending: (
    input: Pick<ExecutePortRowActionInput, "environmentId" | "threadId" | "port">,
  ) => boolean;
}

const actionKey = (input: Pick<ExecutePortRowActionInput, "environmentId" | "threadId" | "port">) =>
  JSON.stringify([input.environmentId, input.threadId, input.port]);

export function createPortRowActionExecutor(
  dependencies: PortRowActionExecutorDependencies,
): PortRowActionExecutor {
  const pending = new Set<string>();

  return {
    isPending: (input) => pending.has(actionKey(input)),
    execute: async (input) => {
      if (input.action.kind === "none") return { status: "skipped" };
      const key = actionKey(input);
      if (pending.has(key)) return { status: "skipped" };
      pending.add(key);
      let reservedExternal: ReturnType<NonNullable<typeof dependencies.reserveExternal>> | null =
        null;
      try {
        if (input.action.kind === "set-enabled") {
          await (dependencies.setPortEnabled ?? dependencies.controller.setPortEnabled)({
            environmentId: input.environmentId,
            threadId: input.threadId,
            port: input.port,
            enabled: input.action.enabled,
          });
          if (!input.action.enabled) return { status: "completed" };
          const resolution = await dependencies.controller.prepare({
            environmentId: input.environmentId,
            threadId: input.threadId,
            target: input.target,
          });
          return resolution.state === "ready"
            ? { status: "completed", cleanUrl: resolution.cleanUrl }
            : { status: "unavailable", cleanUrl: resolution.cleanUrl, resolution };
        }

        if (input.action.destination === "external" && dependencies.reserveExternal) {
          reservedExternal = dependencies.reserveExternal();
        }

        const resolution = await dependencies.controller.prepare({
          environmentId: input.environmentId,
          threadId: input.threadId,
          target: input.target,
        });
        if (resolution.state !== "ready") {
          reservedExternal?.close();
          reservedExternal = null;
          return { status: "unavailable", cleanUrl: resolution.cleanUrl, resolution };
        }
        switch (input.action.destination) {
          case "preview":
            await dependencies.openPreview(resolution.launchUrl);
            break;
          case "external":
            if (reservedExternal) {
              await reservedExternal.navigate(resolution.launchUrl);
              reservedExternal = null;
            } else {
              await dependencies.openExternal(resolution.launchUrl);
            }
            break;
          case "copy":
            await dependencies.copyText(resolution.launchUrl);
            break;
        }
        return { status: "completed", cleanUrl: resolution.cleanUrl };
      } catch (error) {
        reservedExternal?.close();
        throw error;
      } finally {
        pending.delete(key);
      }
    },
  };
}
