import type {
  AdvertisedEndpoint,
  DesktopBridge,
  DesktopWslState,
  PreviewTailnetStatusResult,
  TailnetPreviewReadiness,
} from "@t3tools/contracts";

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

const TAILSCALE_PREVIEW_BASE_DESCRIPTION =
  "Publish this environment’s current-thread dev server previews to your Tailnet. Open them from a browser device connected to the same Tailnet and allowed by its ACL.";

export interface TailscalePreviewSettingView {
  readonly checked: boolean;
  readonly status: string | null;
  readonly description: string;
}

export function supportsTailscalePreviewSettings(
  capability: { readonly protocolVersion: 1; readonly requiredScope: "preview:access" } | undefined,
): boolean {
  return capability?.protocolVersion === 1;
}

function describeTailscalePreviewReadiness(
  readiness: TailnetPreviewReadiness,
): Pick<TailscalePreviewSettingView, "status" | "description"> {
  switch (readiness) {
    case "ready":
      return {
        status: "Active",
        description:
          "Open previews from a browser device connected to the same Tailnet and allowed by its ACL.",
      };
    case "disabled":
      return {
        status: "Closed",
        description:
          "Enable Tailscale previews to publish this environment’s current-thread Ports again.",
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
          "On Linux, an operator can grant the Verne service account permission with `sudo tailscale set --operator=<service account>`. Verne never runs sudo.",
      };
    case "mapping-conflict":
      return {
        status: "Port conflict",
        description:
          "A Tailnet preview mapping is already using one of this environment’s target ports. Verne left that mapping unchanged.",
      };
    case "gateway-failed":
      return {
        status: "Unavailable",
        description: "Verne could not start or reach the preview gateway. Retry from Ports.",
      };
    case "capacity-reached":
      return {
        status: "Capacity reached",
        description: "This environment has reached its 16-port preview capacity.",
      };
  }
}

export function resolveTailscalePreviewSettingView(input: {
  readonly supported: boolean;
  readonly status: PreviewTailnetStatusResult | null;
  readonly statusPending: boolean;
  readonly pendingEnabled: boolean | null;
  readonly mutationError: string | null;
}): TailscalePreviewSettingView | null {
  if (!input.supported) return null;

  const checked = input.pendingEnabled ?? input.status?.enabled ?? false;
  if (input.pendingEnabled !== null) {
    return {
      checked,
      status: input.pendingEnabled ? "Enabling…" : "Closing…",
      description: input.pendingEnabled
        ? "Saving this environment’s Tailnet preview opt-in."
        : "Closing active Tailnet preview publications and disabling new ones.",
    };
  }
  if (input.mutationError !== null) {
    return {
      checked,
      status: "Update failed",
      description: input.mutationError,
    };
  }
  if (input.statusPending && input.status === null) {
    return {
      checked,
      status: "Checking status…",
      description: TAILSCALE_PREVIEW_BASE_DESCRIPTION,
    };
  }
  if (input.status === null) {
    return {
      checked,
      status: checked ? "Enabled" : null,
      description: TAILSCALE_PREVIEW_BASE_DESCRIPTION,
    };
  }
  const presentation = describeTailscalePreviewReadiness(input.status.readiness);
  return {
    checked,
    status: presentation.status,
    description: presentation.description,
  };
}

export async function applyTailscalePreviewsSettingChange(input: {
  readonly enabled: boolean;
  readonly hasActivePublications: boolean;
  readonly patchSettings: (patch: { readonly tailscalePreviewsEnabled: boolean }) => Promise<void>;
  readonly confirmDisable: () => Promise<boolean>;
}): Promise<"updated" | "cancelled"> {
  if (!input.enabled && input.hasActivePublications) {
    const confirmed = await input.confirmDisable();
    if (!confirmed) return "cancelled";
  }
  await input.patchSettings({ tailscalePreviewsEnabled: input.enabled });
  return "updated";
}

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

export type QrEndpointOption = {
  /** Unique per endpoint instance (AdvertisedEndpoint.id); safe as a React key. */
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  /** False for endpoints that stay copyable but must never render as a QR. */
  readonly qrShareable: boolean;
};

/**
 * Resolves which endpoint the share panel shows: the user's explicit pick,
 * else the saved default endpoint, else the first QR-shareable option (so the
 * panel never opens on a loopback QR), else the first option. A stale
 * selectedId (endpoint disappeared) falls back rather than blanking the panel.
 */
export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
