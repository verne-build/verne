import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readPreparedConnection: vi.fn(),
  runAtomCommand: vi.fn(),
  ensurePortForward: vi.fn(),
  releasePortForward: vi.fn(),
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    acquirePortForward: {},
    releasePortForward: {},
  },
}));

describe("desktop port-forward state", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readPreparedConnection.mockReset();
    mocks.runAtomCommand.mockReset();
    mocks.ensurePortForward.mockReset();
    mocks.releasePortForward.mockReset();
    mocks.readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://relay.example.test",
      target: { _tag: "RelayConnectionTarget" },
    });
    mocks.runAtomCommand.mockImplementation(async (_registry, _atom, input) =>
      "port" in input.input
        ? {
            _tag: "Success",
            value: {
              leaseId: "lease-5173",
              ticket: "ticket-5173",
              port: 5173,
              connectHost: "127.0.0.1",
              expiresAt: "2026-09-02T04:00:00.000Z",
            },
          }
        : { _tag: "Success", value: undefined },
    );
    mocks.ensurePortForward.mockResolvedValue({
      localPort: 45173,
      localUrl: "http://localhost:45173/",
    });
    mocks.releasePortForward.mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        ensurePortForward: mocks.ensurePortForward,
        releasePortForward: mocks.releasePortForward,
        onPortForwardClosed: vi.fn(),
      },
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });
  });

  it("reports the active fallback listener URL and persistent suppression across remount reads", async () => {
    const environmentId = EnvironmentId.make("environment-forward-state");
    const forwarding = await import("./prepareBrowserNavigationTarget");

    const initial = await forwarding.prepareBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: "http://localhost:5173/",
    });
    expect(initial.resolvedUrl).toBe("http://localhost:45173/");
    expect(forwarding.readPortForwardState(environmentId, 5173)).toEqual({
      state: "active",
      localPort: 45173,
      localUrl: "http://localhost:45173/",
    });

    await forwarding.disablePortForward(environmentId, 5173);
    expect(forwarding.readPortForwardState(environmentId, 5173)).toEqual({
      state: "suppressed",
    });

    const enabled = await forwarding.enablePortForward(environmentId, "http://localhost:5173/");
    expect(enabled.resolvedUrl).toBe("http://localhost:45173/");
    expect(forwarding.readPortForwardState(environmentId, 5173)).toEqual({
      state: "active",
      localPort: 45173,
      localUrl: "http://localhost:45173/",
    });
  });

  it("shares same-port establishment while preserving each concurrent navigation URL", async () => {
    const environmentId = EnvironmentId.make("environment-concurrent-paths");
    let resolveEnsure: ((value: { localPort: number; localUrl: string }) => void) | undefined;
    mocks.ensurePortForward.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnsure = resolve;
        }),
    );
    const forwarding = await import("./prepareBrowserNavigationTarget");

    const first = forwarding.prepareBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: "http://localhost:5173/first?mode=one#first",
    });
    await vi.waitFor(() => expect(mocks.ensurePortForward).toHaveBeenCalledTimes(1));
    const second = forwarding.prepareBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: "http://localhost:5173/second?mode=two#second",
    });

    resolveEnsure?.({ localPort: 45173, localUrl: "http://localhost:45173/" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        requestedUrl: "http://localhost:5173/first?mode=one#first",
        resolvedUrl: "http://localhost:45173/first?mode=one#first",
        resolutionKind: "authenticated-tunnel",
        environmentId,
      },
      {
        requestedUrl: "http://localhost:5173/second?mode=two#second",
        resolvedUrl: "http://localhost:45173/second?mode=two#second",
        resolutionKind: "authenticated-tunnel",
        environmentId,
      },
    ]);
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePortForward).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale disable delete a re-enabled replacement", async () => {
    const environmentId = EnvironmentId.make("environment-stale-disable");
    let acquisition = 0;
    mocks.runAtomCommand.mockImplementation(async (_registry, _atom, command) => {
      if (!("port" in command.input)) return { _tag: "Success", value: undefined };
      acquisition += 1;
      return {
        _tag: "Success",
        value: {
          leaseId: `lease-${acquisition}`,
          ticket: `ticket-${acquisition}`,
          port: 5173,
          connectHost: "127.0.0.1",
          expiresAt: "2026-09-02T04:00:00.000Z",
        },
      };
    });
    mocks.ensurePortForward
      .mockResolvedValueOnce({ localPort: 45173, localUrl: "http://localhost:45173/" })
      .mockResolvedValueOnce({ localPort: 45174, localUrl: "http://localhost:45174/" });
    let finishStaleRelease: (() => void) | undefined;
    mocks.releasePortForward.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStaleRelease = resolve;
        }),
    );
    const forwarding = await import("./prepareBrowserNavigationTarget");
    await forwarding.prepareBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: "http://localhost:5173/first",
    });

    const disabling = forwarding.disablePortForward(environmentId, 5173);
    await vi.waitFor(() => expect(mocks.releasePortForward).toHaveBeenCalledTimes(1));
    const replacement = await forwarding.enablePortForward(
      environmentId,
      "http://localhost:5173/second",
    );
    expect(replacement.resolvedUrl).toBe("http://localhost:45174/second");

    finishStaleRelease?.();
    await disabling;
    expect(forwarding.readPortForwardState(environmentId, 5173)).toEqual({
      state: "active",
      localPort: 45174,
      localUrl: "http://localhost:45174/",
    });
  });

  it("closes and releases an establishment that finishes after disable", async () => {
    const environmentId = EnvironmentId.make("environment-disable-pending");
    let finishEnsure:
      | ((value: { readonly localPort: number; readonly localUrl: string }) => void)
      | undefined;
    mocks.ensurePortForward.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishEnsure = resolve;
        }),
    );
    const forwarding = await import("./prepareBrowserNavigationTarget");
    const preparation = forwarding.prepareBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: "http://localhost:5173/pending",
    });
    const rejected = expect(preparation).rejects.toThrow(/no longer requested/);
    await vi.waitFor(() => expect(mocks.ensurePortForward).toHaveBeenCalledTimes(1));

    await forwarding.disablePortForward(environmentId, 5173);
    finishEnsure?.({ localPort: 45173, localUrl: "http://localhost:45173/" });

    await rejected;
    await vi.waitFor(() => expect(mocks.releasePortForward).toHaveBeenCalledTimes(1));
    expect(mocks.releasePortForward).toHaveBeenCalledWith({
      environmentId,
      leaseId: "lease-5173",
      remotePort: 5173,
    });
    expect(forwarding.readPortForwardState(environmentId, 5173)).toEqual({
      state: "suppressed",
    });
  });
});
