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
});
