import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PreviewAccessResolution } from "~/browser/previewAccessController";
import {
  createPortRowActionExecutor,
  describePortReadiness,
  resolvePortRowAccessState,
  resolvePortRowAction,
  resolvePortRowPresentation,
} from "./portRowActions";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

const ready = (generation: number): PreviewAccessResolution => ({
  state: "ready",
  transport: "tailnet",
  requestedUrl: "http://localhost:5173/",
  cleanUrl: "https://machine.tailnet.ts.net:5173/",
  launchUrl: `https://machine.tailnet.ts.net:5173/.well-known/verne-preview/auth#launch-${generation}`,
  resolutionKind: "tailnet-publication",
  readiness: "ready",
});

const request = {
  environmentId,
  threadId,
  port: 5173,
  target: { kind: "environment-port", port: 5173 } as const,
};

describe("resolvePortRowAction", () => {
  it("prepares a desktop plain click for Verne Preview", () => {
    expect(
      resolvePortRowAction({
        surface: "desktop",
        intent: "row-open",
        platform: "MacIntel",
        modifiers: { metaKey: false, ctrlKey: false },
        portState: "active",
        pending: false,
      }),
    ).toEqual({ kind: "prepare", destination: "preview" });
  });

  it("uses Command on macOS and Control elsewhere for the desktop browser action", () => {
    expect(
      resolvePortRowAction({
        surface: "desktop",
        intent: "row-open",
        platform: "MacIntel",
        modifiers: { metaKey: true, ctrlKey: false },
        portState: "active",
        pending: false,
      }),
    ).toEqual({ kind: "prepare", destination: "external" });
    expect(
      resolvePortRowAction({
        surface: "desktop",
        intent: "row-open",
        platform: "Linux x86_64",
        modifiers: { metaKey: false, ctrlKey: true },
        portState: "active",
        pending: false,
      }),
    ).toEqual({ kind: "prepare", destination: "external" });
    expect(
      resolvePortRowAction({
        surface: "desktop",
        intent: "row-open",
        platform: "MacIntel",
        modifiers: { metaKey: false, ctrlKey: true },
        portState: "active",
        pending: false,
      }),
    ).toEqual({ kind: "prepare", destination: "preview" });
  });

  it("prepares the explicit desktop browser button for the system browser", () => {
    expect(
      resolvePortRowAction({
        surface: "desktop",
        intent: "browser-open",
        platform: "MacIntel",
        modifiers: { metaKey: false, ctrlKey: false },
        portState: "active",
        pending: false,
      }),
    ).toEqual({ kind: "prepare", destination: "external" });
  });

  it.each(["row-open", "browser-open"] as const)(
    "opens web %s through a fresh external launch",
    (intent) => {
      expect(
        resolvePortRowAction({
          surface: "web",
          intent,
          platform: "Linux x86_64",
          modifiers: { metaKey: intent === "row-open", ctrlKey: false },
          portState: "active",
          pending: false,
        }),
      ).toEqual({ kind: "prepare", destination: "external" });
    },
  );

  it("maps copy to a fresh prepared launch and toggles suppression in both directions", () => {
    expect(
      resolvePortRowAction({
        surface: "web",
        intent: "copy",
        platform: "Linux",
        modifiers: { metaKey: false, ctrlKey: false },
        portState: "active",
        pending: false,
      }),
    ).toEqual({ kind: "prepare", destination: "copy" });
    expect(
      resolvePortRowAction({
        surface: "web",
        intent: "toggle",
        platform: "Linux",
        modifiers: { metaKey: false, ctrlKey: false },
        portState: "active",
        pending: false,
      }),
    ).toEqual({ kind: "set-enabled", enabled: false });
    expect(
      resolvePortRowAction({
        surface: "web",
        intent: "toggle",
        platform: "Linux",
        modifiers: { metaKey: false, ctrlKey: false },
        portState: "suppressed",
        pending: false,
      }),
    ).toEqual({ kind: "set-enabled", enabled: true });
  });

  it("blocks every row operation while that port is pending", () => {
    expect(
      resolvePortRowAction({
        surface: "web",
        intent: "copy",
        platform: "Linux",
        modifiers: { metaKey: false, ctrlKey: false },
        portState: "active",
        pending: true,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("createPortRowActionExecutor", () => {
  it("opens each web action with a newly acquired fragment-bearing launch URL", async () => {
    let generation = 0;
    const prepare = vi.fn(async () => ready(++generation));
    const openExternal = vi.fn(async (_url: string) => undefined);
    const executor = createPortRowActionExecutor({
      controller: { prepare, setPortEnabled: vi.fn() },
      openPreview: async () => undefined,
      openExternal,
      copyText: async () => undefined,
    });

    await executor.execute({
      ...request,
      action: { kind: "prepare", destination: "external" },
    });
    await executor.execute({
      ...request,
      action: { kind: "prepare", destination: "external" },
    });

    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      "https://machine.tailnet.ts.net:5173/.well-known/verne-preview/auth#launch-1",
      "https://machine.tailnet.ts.net:5173/.well-known/verne-preview/auth#launch-2",
    ]);
  });

  it("uses the exact same resolved localhost URL for desktop Preview and browser opens", async () => {
    const opened: string[] = [];
    const resolution: PreviewAccessResolution = {
      state: "ready",
      transport: "desktop-forward",
      requestedUrl: "http://localhost:5173/",
      cleanUrl: "http://localhost:45173/",
      launchUrl: "http://localhost:45173/",
      resolutionKind: "authenticated-tunnel",
      readiness: "ready",
    };
    const executor = createPortRowActionExecutor({
      controller: {
        prepare: async () => resolution,
        setPortEnabled: vi.fn(),
      },
      openPreview: async (url) => {
        opened.push(`preview:${url}`);
      },
      openExternal: async (url) => {
        opened.push(`external:${url}`);
      },
      copyText: async () => undefined,
    });

    await executor.execute({
      ...request,
      action: { kind: "prepare", destination: "preview" },
    });
    await executor.execute({
      ...request,
      action: { kind: "prepare", destination: "external" },
    });

    expect(opened).toEqual(["preview:http://localhost:45173/", "external:http://localhost:45173/"]);
  });

  it("copies a fresh launch capability while returning the clean URL for presentation", async () => {
    let generation = 0;
    const copied: string[] = [];
    const executor = createPortRowActionExecutor({
      controller: {
        prepare: async () => ready(++generation),
        setPortEnabled: vi.fn(),
      },
      openPreview: async () => undefined,
      openExternal: async () => undefined,
      copyText: async (url) => {
        copied.push(url);
      },
    });

    const first = await executor.execute({
      ...request,
      action: { kind: "prepare", destination: "copy" },
    });
    const second = await executor.execute({
      ...request,
      action: { kind: "prepare", destination: "copy" },
    });

    expect(copied).toEqual([
      "https://machine.tailnet.ts.net:5173/.well-known/verne-preview/auth#launch-1",
      "https://machine.tailnet.ts.net:5173/.well-known/verne-preview/auth#launch-2",
    ]);
    expect(first).toMatchObject({ status: "completed", cleanUrl: ready(1).cleanUrl });
    expect(second).toMatchObject({ status: "completed", cleanUrl: ready(2).cleanUrl });
    expect(copied).not.toContain(ready(1).cleanUrl);
  });

  it("single-flights a pending port action instead of acquiring twice", async () => {
    let resolvePrepare!: (resolution: PreviewAccessResolution) => void;
    const prepare = vi.fn(
      () =>
        new Promise<PreviewAccessResolution>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const executor = createPortRowActionExecutor({
      controller: { prepare, setPortEnabled: vi.fn() },
      openPreview: async () => undefined,
      openExternal: async () => undefined,
      copyText: async () => undefined,
    });

    const first = executor.execute({
      ...request,
      action: { kind: "prepare", destination: "external" },
    });
    const duplicate = await executor.execute({
      ...request,
      action: { kind: "prepare", destination: "copy" },
    });
    resolvePrepare(ready(1));

    expect(duplicate).toEqual({ status: "skipped" });
    await expect(first).resolves.toMatchObject({ status: "completed" });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("reacquires after enabling a suppressed port without opening the launch URL", async () => {
    const calls: string[] = [];
    const executor = createPortRowActionExecutor({
      controller: {
        setPortEnabled: async ({ enabled }) => {
          calls.push(`enabled:${enabled}`);
        },
        prepare: async () => {
          calls.push("prepare");
          return ready(1);
        },
      },
      openPreview: async () => {
        calls.push("preview");
      },
      openExternal: async () => {
        calls.push("external");
      },
      copyText: async () => {
        calls.push("copy");
      },
    });

    const outcome = await executor.execute({
      ...request,
      action: { kind: "set-enabled", enabled: true },
    });

    expect(calls).toEqual(["enabled:true", "prepare"]);
    expect(outcome).toEqual({
      status: "completed",
      cleanUrl: "https://machine.tailnet.ts.net:5173/",
    });
  });
});

describe("describePortReadiness", () => {
  it.each([
    ["disabled", "Set up Tailnet previews in Settings → Connections."],
    ["tailscale-unavailable", "Install and start Tailscale on the environment."],
    ["not-logged-in", "Sign in to Tailscale on the environment."],
    ["magic-dns-unavailable", "Enable MagicDNS for the tailnet."],
    ["https-unavailable", "Enable Tailscale HTTPS for the tailnet."],
    [
      "permission-denied",
      "On Linux, an operator can grant the Verne account permission with `sudo tailscale set --operator=<user>`. Verne never runs sudo.",
    ],
    [
      "mapping-conflict",
      "This Tailnet port is mapped to another target. Verne left that mapping unchanged.",
    ],
    ["gateway-failed", "Verne could not start or reach the preview gateway. Retry the port."],
    ["capacity-reached", "This environment has reached its 16-port preview capacity."],
  ] as const)("maps %s to actionable remediation", (readiness, description) => {
    expect(describePortReadiness(readiness).description).toBe(description);
  });
});

describe("resolvePortRowPresentation", () => {
  it("distinguishes desktop readiness from web publication", () => {
    const common = {
      accessState: { state: "idle" } as const,
      present: true,
      overCapacity: false,
      supportsTailnet: true,
      tailnetEnabled: true,
      operationIssue: null,
    };

    expect(resolvePortRowPresentation({ ...common, surface: "desktop" })).toMatchObject({
      state: "idle",
      status: "Ready",
    });
    expect(resolvePortRowPresentation({ ...common, surface: "web" })).toMatchObject({
      state: "publishing",
      status: "Publishing",
    });
  });

  it("keeps suppressed and disappeared rows honest", () => {
    expect(
      resolvePortRowPresentation({
        accessState: { state: "suppressed" },
        present: true,
        overCapacity: false,
        surface: "web",
        supportsTailnet: true,
        tailnetEnabled: true,
        operationIssue: null,
      }),
    ).toMatchObject({ state: "suppressed", status: "Disabled" });
    expect(
      resolvePortRowPresentation({
        accessState: { state: "active", cleanUrl: "https://example.test", expiresAt: "later" },
        present: false,
        overCapacity: false,
        surface: "web",
        supportsTailnet: true,
        tailnetEnabled: true,
        operationIssue: null,
      }),
    ).toMatchObject({ state: "disappearing", status: "Closed" });
  });

  it("surfaces setup, capability, conflict, and capacity diagnostics", () => {
    const common = {
      accessState: { state: "idle" } as const,
      present: true,
      surface: "web" as const,
      operationIssue: null,
    };

    expect(
      resolvePortRowPresentation({
        ...common,
        overCapacity: false,
        supportsTailnet: false,
        tailnetEnabled: true,
      }),
    ).toMatchObject({ state: "unavailable", status: "Unavailable" });
    expect(
      resolvePortRowPresentation({
        ...common,
        overCapacity: false,
        supportsTailnet: true,
        tailnetEnabled: false,
      }),
    ).toMatchObject({ state: "setup-required", status: "Setup required" });
    expect(
      resolvePortRowPresentation({
        ...common,
        accessState: { state: "unavailable", readiness: "mapping-conflict" },
        overCapacity: false,
        supportsTailnet: true,
        tailnetEnabled: true,
      }),
    ).toMatchObject({ state: "unavailable", status: "Port conflict" });
    expect(
      resolvePortRowPresentation({
        ...common,
        overCapacity: true,
        supportsTailnet: true,
        tailnetEnabled: true,
      }),
    ).toMatchObject({ state: "unavailable", status: "Capacity reached" });
  });

  it("lets recovered controller state replace a stale operation error", () => {
    expect(
      resolvePortRowPresentation({
        accessState: {
          state: "active",
          cleanUrl: "https://machine.tailnet.ts.net:5173/",
          expiresAt: "later",
        },
        present: true,
        overCapacity: false,
        surface: "web",
        supportsTailnet: true,
        tailnetEnabled: true,
        operationIssue: { state: "unavailable", readiness: "mapping-conflict" },
      }),
    ).toMatchObject({
      state: "active",
      status: "Active",
      description: expect.stringContaining("same Tailnet"),
    });
  });

  it("keeps unsupported environments as update-server guidance", () => {
    const presentation = resolvePortRowPresentation({
      accessState: { state: "idle" },
      present: true,
      overCapacity: false,
      surface: "web",
      supportsTailnet: true,
      tailnetEnabled: true,
      operationIssue: { state: "unsupported" },
    });

    expect(presentation).toMatchObject({
      state: "unavailable",
      status: "Update required",
      description: expect.stringContaining("Update this environment’s Verne server"),
    });
    expect(presentation.description).not.toContain("Tailscale");
  });
});

describe("resolvePortRowAccessState", () => {
  it("restores desktop suppression from the forwarding subsystem", () => {
    expect(
      resolvePortRowAccessState({
        surface: "desktop",
        controllerState: { state: "idle" },
        desktopForwardState: { state: "suppressed" },
      }),
    ).toEqual({ state: "suppressed" });
  });

  it("restores the exact active desktop fallback URL", () => {
    expect(
      resolvePortRowAccessState({
        surface: "desktop",
        controllerState: { state: "idle" },
        desktopForwardState: {
          state: "active",
          localPort: 45_173,
          localUrl: "http://localhost:45173/",
        },
      }),
    ).toEqual({
      state: "active",
      cleanUrl: "http://localhost:45173/",
      expiresAt: "",
    });
  });
});
