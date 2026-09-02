import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ThreadId,
  type DiscoveredLocalServer,
  type PreviewTailnetAcquireResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewAccessController,
  type PreviewAccessControllerDependencies,
  type PreviewAccessEnvironment,
} from "./previewAccessController";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

const primaryTarget = new PrimaryConnectionTarget({
  environmentId,
  label: "Local",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

const tailnetResult = (port: number, generation = 1): PreviewTailnetAcquireResult => ({
  leaseId: `lease-${port}`,
  port,
  cleanUrl: `https://machine.tailnet.ts.net:${port}/app`,
  launchUrl: `https://machine.tailnet.ts.net:${port}/.well-known/verne-preview/auth#launch-${generation}`,
  expiresAt: "2026-09-02T12:00:00.000Z",
  readiness: "ready",
});

const server = (port: number, owner: string = threadId): DiscoveredLocalServer => ({
  host: "localhost",
  connectHost: "127.0.0.1",
  port,
  url: `http://localhost:${port}/app`,
  processName: "vite",
  pid: 1000 + port,
  terminal: { threadId: ThreadId.make(owner), terminalId: `terminal-${port}` },
});

function environment(overrides: Partial<PreviewAccessEnvironment> = {}): PreviewAccessEnvironment {
  return {
    connection: {
      httpBaseUrl: "http://127.0.0.1:3773",
      target: primaryTarget,
    },
    tailnetPreviewPublishing: { protocolVersion: 1, requiredScope: "preview:access" },
    tailscalePreviewsEnabled: true,
    ...overrides,
  };
}

function manualTimers() {
  let nextId = 0;
  const pending = new Map<
    number,
    { readonly callback: () => void | Promise<void>; readonly delayMs: number }
  >();
  return {
    api: {
      setTimeout: (callback: () => void | Promise<void>, delayMs: number) => {
        const id = ++nextId;
        pending.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout: (id: unknown) => pending.delete(id as number),
    },
    size: () => pending.size,
    delays: () => [...pending.values()].map(({ delayMs }) => delayMs),
    fireAll: async () => {
      const callbacks = [...pending.values()].map(({ callback }) => callback);
      pending.clear();
      await Promise.all(callbacks.map((callback) => callback()));
    },
  };
}

function dependencies(
  input: {
    readonly surface?: "desktop" | "web";
    readonly environment?: PreviewAccessEnvironment;
    readonly acquire?: PreviewAccessControllerDependencies["tailnet"]["acquire"];
    readonly renew?: PreviewAccessControllerDependencies["tailnet"]["renew"];
    readonly release?: PreviewAccessControllerDependencies["tailnet"]["release"];
    readonly setPortEnabled?: PreviewAccessControllerDependencies["tailnet"]["setPortEnabled"];
    readonly prepareDesktop?: PreviewAccessControllerDependencies["prepareDesktop"];
    readonly timers?: PreviewAccessControllerDependencies["timers"];
  } = {},
) {
  return {
    surface: input.surface ?? "web",
    readEnvironment: vi.fn(() => input.environment ?? environment()),
    prepareDesktop:
      input.prepareDesktop ??
      vi.fn(async ({ target }) => ({
        requestedUrl: target.kind === "url" ? target.url : `http://localhost:${target.port}/`,
        resolvedUrl: target.kind === "url" ? target.url : `http://localhost:${target.port}/`,
        resolutionKind: "direct" as const,
        environmentId,
      })),
    tailnet: {
      status: vi.fn(async () => ({ enabled: true, readiness: "ready" as const })),
      acquire: input.acquire ?? vi.fn(async ({ port }) => tailnetResult(port)),
      renew: input.renew ?? vi.fn(async ({ port }) => tailnetResult(port)),
      release: input.release ?? vi.fn(async () => undefined),
      setPortEnabled:
        input.setPortEnabled ?? vi.fn(async () => ({ enabled: true, readiness: "ready" as const })),
    },
    timers:
      input.timers ??
      ({
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      } satisfies PreviewAccessControllerDependencies["timers"]),
    now: () => Date.parse("2026-09-02T11:59:00.000Z"),
  } satisfies PreviewAccessControllerDependencies;
}

describe("preview access controller", () => {
  it.each([
    ["primary", primaryTarget],
    [
      "desktop-local bearer",
      new BearerConnectionTarget({
        environmentId,
        label: "WSL",
        connectionId: "local:wsl-ubuntu",
      }),
    ],
  ])(
    "keeps desktop %s targets on the requested localhost URL without a lease",
    async (_name, target) => {
      const acquire = vi.fn(async ({ port }: { readonly port: number }) => tailnetResult(port));
      const prepareDesktop = vi.fn();
      const controller = createPreviewAccessController(
        dependencies({
          surface: "desktop",
          environment: environment({
            connection: { httpBaseUrl: "http://127.0.0.1:3773", target },
          }),
          acquire,
          prepareDesktop,
        }),
      );

      await expect(
        controller.prepare({
          environmentId,
          threadId,
          target: { kind: "url", url: "http://localhost:5173/app" },
        }),
      ).resolves.toMatchObject({
        state: "ready",
        transport: "direct",
        cleanUrl: "http://localhost:5173/app",
        launchUrl: "http://localhost:5173/app",
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(prepareDesktop).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "SSH",
      "http://127.0.0.1:43881",
      new SshConnectionTarget({ environmentId, label: "SSH", connectionId: "ssh-1" }),
    ],
    [
      "relay",
      "https://relay.example.com",
      new RelayConnectionTarget({ environmentId, label: "Relay" }),
    ],
    [
      "LAN bearer",
      "http://192.168.1.25:3773",
      new BearerConnectionTarget({ environmentId, label: "LAN", connectionId: "lan-1" }),
    ],
    [
      "Tailnet bearer",
      "http://100.65.180.100:3773",
      new BearerConnectionTarget({ environmentId, label: "Tailnet", connectionId: "tailnet-1" }),
    ],
  ])(
    "uses authenticated desktop forwarding for a remote %s target",
    async (_name, httpBaseUrl, target) => {
      const prepareDesktop = vi.fn(async () => ({
        requestedUrl: "http://localhost:5173/app",
        resolvedUrl: "http://localhost:45173/app",
        resolutionKind: "authenticated-tunnel" as const,
        environmentId,
      }));
      const controller = createPreviewAccessController(
        dependencies({
          surface: "desktop",
          environment: environment({ connection: { httpBaseUrl, target } }),
          prepareDesktop,
        }),
      );

      await expect(
        controller.prepare({
          environmentId,
          threadId,
          target: { kind: "url", url: "http://localhost:5173/app" },
        }),
      ).resolves.toMatchObject({
        state: "ready",
        transport: "desktop-forward",
        cleanUrl: "http://localhost:45173/app",
        resolutionKind: "authenticated-tunnel",
      });
      expect(prepareDesktop).toHaveBeenCalledOnce();
    },
  );

  it("publishes through Tailnet on a capable, opted-in web environment", async () => {
    const controller = createPreviewAccessController(dependencies());

    await expect(
      controller.prepare({
        environmentId,
        threadId,
        target: { kind: "url", url: "http://localhost:5173/app" },
      }),
    ).resolves.toMatchObject({
      state: "ready",
      transport: "tailnet",
      cleanUrl: "https://machine.tailnet.ts.net:5173/app",
      launchUrl: "https://machine.tailnet.ts.net:5173/.well-known/verne-preview/auth#launch-1",
    });
  });

  it("reports unsupported without RPCs when the web capability is absent", async () => {
    const deps = dependencies({
      environment: environment({ tailnetPreviewPublishing: undefined }),
    });
    const controller = createPreviewAccessController(deps);

    await expect(
      controller.prepare({
        environmentId,
        threadId,
        target: { kind: "url", url: "http://localhost:5173" },
      }),
    ).resolves.toMatchObject({ state: "unsupported" });
    expect(deps.tailnet.status).not.toHaveBeenCalled();
    expect(deps.tailnet.acquire).not.toHaveBeenCalled();
  });

  it("reports setup-required without acquiring when web publication is opted out", async () => {
    const deps = dependencies({
      environment: environment({ tailscalePreviewsEnabled: false }),
    });
    const controller = createPreviewAccessController(deps);

    await expect(
      controller.prepare({
        environmentId,
        threadId,
        target: { kind: "url", url: "http://localhost:5173" },
      }),
    ).resolves.toMatchObject({ state: "setup-required", readiness: "disabled" });
    expect(deps.tailnet.acquire).not.toHaveBeenCalled();
  });

  it.each(["desktop", "web"] as const)("leaves non-loopback URLs direct on %s", async (surface) => {
    const deps = dependencies({
      surface,
      environment: environment({
        connection: {
          httpBaseUrl: "https://relay.example.com",
          target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
        },
      }),
    });
    const controller = createPreviewAccessController(deps);

    await expect(
      controller.prepare({
        environmentId,
        threadId,
        target: { kind: "url", url: "https://example.com/docs" },
      }),
    ).resolves.toMatchObject({
      state: "ready",
      transport: "direct",
      cleanUrl: "https://example.com/docs",
    });
    expect(deps.prepareDesktop).not.toHaveBeenCalled();
    expect(deps.tailnet.acquire).not.toHaveBeenCalled();
  });

  it("single-flights concurrent acquisitions for one thread and port", async () => {
    let resolveAcquire!: (result: PreviewTailnetAcquireResult) => void;
    const acquire = vi.fn(
      () => new Promise<PreviewTailnetAcquireResult>((resolve) => (resolveAcquire = resolve)),
    );
    const controller = createPreviewAccessController(dependencies({ acquire }));
    const input = {
      environmentId,
      threadId,
      target: { kind: "url" as const, url: "http://localhost:5173/app" },
    };

    const first = controller.prepare(input);
    const second = controller.prepare(input);
    expect(acquire).toHaveBeenCalledOnce();
    resolveAcquire(tailnetResult(5173));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("requests a fresh launch URL for each sequential web action", async () => {
    let generation = 0;
    const acquire = vi.fn(async ({ port }: { readonly port: number }) =>
      tailnetResult(port, ++generation),
    );
    const controller = createPreviewAccessController(dependencies({ acquire }));
    const input = {
      environmentId,
      threadId,
      target: { kind: "url" as const, url: "http://localhost:5173/app" },
    };

    const first = await controller.prepare(input);
    const second = await controller.prepare(input);
    expect(first.state === "ready" ? first.launchUrl : null).toContain("#launch-1");
    expect(second.state === "ready" ? second.launchUrl : null).toContain("#launch-2");
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("reconciles only current-thread ports, caps acquisition at 16, and delays passive release", async () => {
    const timers = manualTimers();
    const release = vi.fn(async () => undefined);
    const deps = dependencies({ timers: timers.api, release });
    const controller = createPreviewAccessController(deps);
    const current = Array.from({ length: 18 }, (_, index) => server(4000 + index));

    await controller.reconcile({
      environmentId,
      threadId,
      servers: [server(3999, "other-thread"), ...current],
    });
    expect(deps.tailnet.acquire).toHaveBeenCalledTimes(16);
    expect(deps.tailnet.acquire).not.toHaveBeenCalledWith(expect.objectContaining({ port: 3999 }));

    await controller.reconcile({ environmentId, threadId, servers: [] });
    expect(timers.size()).toBe(16);
    expect(new Set(timers.delays())).toEqual(new Set([15_000]));
    expect(release).not.toHaveBeenCalled();

    await timers.fireAll();
    expect(release).toHaveBeenCalledTimes(16);
  });

  it("cancels disappearance cleanup when the same port reappears during grace", async () => {
    const timers = manualTimers();
    const release = vi.fn(async () => undefined);
    const controller = createPreviewAccessController(dependencies({ timers: timers.api, release }));

    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await controller.reconcile({ environmentId, threadId, servers: [] });
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await timers.fireAll();

    expect(release).not.toHaveBeenCalled();
  });

  it("renews an existing automatic lease idempotently", async () => {
    const deps = dependencies();
    const controller = createPreviewAccessController(deps);

    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });

    expect(deps.tailnet.acquire).toHaveBeenCalledOnce();
    expect(deps.tailnet.renew).toHaveBeenCalledOnce();
  });

  it("renews a stable automatic lease before its server-provided expiry", async () => {
    const timers = manualTimers();
    const deps = dependencies({ timers: timers.api });
    const controller = createPreviewAccessController(deps);

    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    expect(timers.size()).toBe(1);
    await timers.fireAll();

    expect(deps.tailnet.renew).toHaveBeenCalledOnce();
  });

  it("marks a disabled process suppressed and releases its owned lease immediately", async () => {
    const release = vi.fn(async () => undefined);
    const setPortEnabled = vi.fn(async () => ({ enabled: true, readiness: "ready" as const }));
    const controller = createPreviewAccessController(dependencies({ release, setPortEnabled }));
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });

    await controller.setPortEnabled({ environmentId, threadId, port: 5173, enabled: false });

    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toMatchObject({
      state: "suppressed",
    });
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
    expect(setPortEnabled).toHaveBeenCalledWith({
      environmentId,
      threadId,
      port: 5173,
      enabled: false,
    });
  });

  it("keeps explicit disable authoritative over an in-flight automatic acquisition", async () => {
    let resolveAcquire!: (result: PreviewTailnetAcquireResult) => void;
    const acquire = vi.fn(
      () => new Promise<PreviewTailnetAcquireResult>((resolve) => (resolveAcquire = resolve)),
    );
    const release = vi.fn(
      async (_input: { readonly environmentId: EnvironmentId; readonly leaseId: string }) =>
        undefined,
    );
    const controller = createPreviewAccessController(dependencies({ acquire, release }));

    const reconciling = controller.reconcile({
      environmentId,
      threadId,
      servers: [server(5173)],
    });
    const disabling = controller.setPortEnabled({
      environmentId,
      threadId,
      port: 5173,
      enabled: false,
    });
    resolveAcquire(tailnetResult(5173));
    await Promise.all([reconciling, disabling]);

    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "suppressed",
    });
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
  });

  it("cleanup releases every lease owned by the controller session", async () => {
    const release = vi.fn(
      async (_input: { readonly environmentId: EnvironmentId; readonly leaseId: string }) =>
        undefined,
    );
    const controller = createPreviewAccessController(dependencies({ release }));
    await controller.reconcile({
      environmentId,
      threadId,
      servers: [server(5173), server(6173)],
    });

    await controller.cleanup();

    expect(release.mock.calls.map(([input]) => input.leaseId).sort()).toEqual([
      "lease-5173",
      "lease-6173",
    ]);
  });
});
