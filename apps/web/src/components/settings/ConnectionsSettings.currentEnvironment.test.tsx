import type { ReactElement } from "react";
import {
  AuthAccessWriteScope,
  AuthPreviewAccessScope,
  EnvironmentId,
  type PreviewTailnetStatusResult,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const testState = vi.hoisted(() => ({
  primaryEnvironment: null as unknown,
  tailnetStatus: {
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  } as {
    data: PreviewTailnetStatusResult | null;
    error: string | null;
    isPending: boolean;
    refresh: () => void;
  },
  tailnetQueries: [] as Array<{ readonly environmentId: string; readonly input: {} }>,
}));

const commands = vi.hoisted(() => ({
  updateSettingsAtom: Symbol("updateSettings"),
  updateSettings: vi.fn(),
  unused: vi.fn(),
}));

const dialogs = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

const notifications = vi.hoisted(() => ({
  add: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ status: "idle" }),
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => testState.primaryEnvironment,
}));

vi.mock("~/environments/primary", () => ({
  createServerPairingCredential: vi.fn(),
  isLoopbackHostname: () => true,
  revokeOtherServerClientSessions: vi.fn(),
  revokeServerClientSession: vi.fn(),
  revokeServerPairingLink: vi.fn(),
  usePrimarySessionState: () => ({
    data: {
      authenticated: true,
      scopes: [AuthAccessWriteScope, AuthPreviewAccessScope],
      auth: { policy: "remote-reachable" },
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === commands.updateSettingsAtom ? commands.updateSettings : commands.unused,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateSettings: commands.updateSettingsAtom,
    updateStateAtom: () => Symbol("updateState"),
  },
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    tailnetStatus: (input: { readonly environmentId: string; readonly input: {} }) => {
      testState.tailnetQueries.push(input);
      return { kind: "tailnet-status" };
    },
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: { readonly kind?: string } | null) =>
    query?.kind === "tailnet-status"
      ? testState.tailnetStatus
      : { data: null, error: null, isPending: false, refresh: vi.fn() },
}));

vi.mock("~/state/auth", () => ({
  authEnvironment: { accessChanges: () => ({ kind: "auth-access" }) },
}));

vi.mock("~/connection/catalog", () => ({
  environmentCatalog: {
    remove: Symbol("remove"),
    retryNow: Symbol("retry"),
  },
}));

vi.mock("~/connection/onboarding", () => ({
  connectPairing: Symbol("connectPairing"),
  connectSshEnvironment: Symbol("connectSshEnvironment"),
}));

vi.mock("~/versionSkew", () => ({
  resolveServerConfigVersionMismatch: () => null,
  resolveServerSelfUpdateCapability: () => null,
}));

vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      defaultAdvertisedEndpointKey: null,
      setDefaultAdvertisedEndpointKey: vi.fn(),
    }),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs }),
  readLocalApi: () => ({ dialogs }),
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: notifications.add },
}));

vi.mock("../../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => false,
  resolveCloudPublicConfig: () => ({
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
    relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
  }),
  resolveRelayTracingConfig: () => null,
}));

vi.mock("../../browser/prepareBrowserNavigationTarget", () => ({
  isEnvironmentAutoForwardEnabled: () => false,
  portForwardSnapshot: () => 0,
  setEnvironmentAutoForwardEnabled: vi.fn(),
  subscribePortForwards: () => () => undefined,
}));

import { ConnectionsSettings } from "./ConnectionsSettings";

const primaryEnvironmentId = EnvironmentId.make("primary-environment");

function primaryEnvironment(options?: {
  readonly supportsTailnet?: boolean;
  readonly enabled?: boolean;
}) {
  return {
    environmentId: primaryEnvironmentId,
    label: "This environment",
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: {
      environment: {
        capabilities: {
          ...(options?.supportsTailnet === false
            ? {}
            : {
                tailnetPreviewPublishing: {
                  protocolVersion: 1,
                  requiredScope: "preview:access",
                },
              }),
        },
      },
      settings: { tailscalePreviewsEnabled: options?.enabled === true },
    },
  };
}

function renderSettings(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ConnectionsSettings() as ReactElement<Record<string, unknown>>;
}

function findTailnetRow(settings: ReactElement<Record<string, unknown>>) {
  return visitElements(settings, (element) => element.props.title === "Tailnet previews");
}

function findTailnetSwitch(settings: ReactElement<Record<string, unknown>>) {
  return visitElements(
    settings,
    (element) => element.props["aria-label"] === "Enable Tailscale previews",
  );
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ConnectionsSettings current environment Tailnet previews", () => {
  beforeEach(() => {
    hooks.reset();
    vi.stubGlobal("window", { desktopBridge: undefined });
    testState.primaryEnvironment = primaryEnvironment();
    testState.tailnetStatus = {
      data: { enabled: false, readiness: "disabled" },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
    testState.tailnetQueries = [];
    commands.updateSettings.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    commands.unused.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    dialogs.confirm.mockReset().mockResolvedValue(true);
    notifications.add.mockReset();
  });

  it("enables Tailnet previews for the authenticated current environment", async () => {
    let resolveUpdate: (result: {
      readonly _tag: "Success";
      readonly value: undefined;
    }) => void = () => undefined;
    commands.updateSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    let settings = renderSettings();
    const row = findTailnetRow(settings);
    let toggle = findTailnetSwitch(settings);

    expect(row).not.toBeNull();
    expect(toggle).not.toBeNull();
    (toggle?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);
    await Promise.resolve();

    settings = renderSettings();
    toggle = findTailnetSwitch(settings);
    expect(toggle?.props.checked).toBe(true);
    expect(toggle?.props.disabled).toBe(true);

    resolveUpdate({ _tag: "Success", value: undefined });
    await flushPromises();

    expect(testState.tailnetQueries).toContainEqual({
      environmentId: primaryEnvironmentId,
      input: {},
    });
    expect(commands.updateSettings).toHaveBeenCalledWith({
      environmentId: primaryEnvironmentId,
      input: { patch: { tailscalePreviewsEnabled: true } },
    });
    expect(dialogs.confirm).not.toHaveBeenCalled();
  });

  it("reports a current-environment update failure and leaves the control usable", async () => {
    commands.updateSettings.mockRejectedValueOnce(new Error("settings write failed"));
    let settings = renderSettings();
    let toggle = findTailnetSwitch(settings);

    (toggle?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);
    await flushPromises();

    settings = renderSettings();
    toggle = findTailnetSwitch(settings);
    expect(toggle?.props.disabled).toBe(false);
    expect(notifications.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not update Tailnet previews",
        description: "settings write failed",
      }),
    );
  });

  it("confirms before disabling an active current-environment publication", async () => {
    testState.primaryEnvironment = primaryEnvironment({ enabled: true });
    testState.tailnetStatus = {
      data: { enabled: true, readiness: "ready" },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
    dialogs.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let settings = renderSettings();
    let toggle = findTailnetSwitch(settings);

    (toggle?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    await flushPromises();
    expect(commands.updateSettings).not.toHaveBeenCalled();

    settings = renderSettings();
    toggle = findTailnetSwitch(settings);
    (toggle?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    await flushPromises();

    expect(dialogs.confirm).toHaveBeenCalledTimes(2);
    expect(commands.updateSettings).toHaveBeenCalledWith({
      environmentId: primaryEnvironmentId,
      input: { patch: { tailscalePreviewsEnabled: false } },
    });
  });

  it("hides the current-environment control from older servers", () => {
    testState.primaryEnvironment = primaryEnvironment({ supportsTailnet: false });
    const settings = renderSettings();

    expect(findTailnetRow(settings)).toBeNull();
    expect(findTailnetSwitch(settings)).toBeNull();
    expect(testState.tailnetQueries).toEqual([]);
  });
});
