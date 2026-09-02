import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  PreviewTailnetLeaseNotFoundError,
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

const server = (
  port: number,
  owner: string = threadId,
  overrides: Partial<DiscoveredLocalServer> = {},
): DiscoveredLocalServer => ({
  host: "localhost",
  connectHost: "127.0.0.1",
  port,
  url: `http://localhost:${port}/app`,
  processName: "vite",
  pid: 1000 + port,
  terminal: { threadId: ThreadId.make(owner), terminalId: `terminal-${port}` },
  ...overrides,
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
  let now = Date.parse("2026-09-02T11:59:00.000Z");
  const pending = new Map<
    number,
    {
      readonly callback: () => void | Promise<void>;
      readonly delayMs: number;
      readonly dueAt: number;
    }
  >();
  return {
    api: {
      setTimeout: (callback: () => void | Promise<void>, delayMs: number) => {
        const id = ++nextId;
        pending.set(id, { callback, delayMs, dueAt: now + delayMs });
        return id;
      },
      clearTimeout: (id: unknown) => pending.delete(id as number),
    },
    size: () => pending.size,
    delays: () => [...pending.values()].map(({ delayMs }) => delayMs),
    now: () => now,
    advanceBy: async (delayMs: number) => {
      now += delayMs;
      const due = [...pending.entries()].filter(([, timer]) => timer.dueAt <= now);
      for (const [id] of due) pending.delete(id);
      await Promise.all(due.map(([, timer]) => timer.callback()));
    },
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
    readonly readEnvironment?: PreviewAccessControllerDependencies["readEnvironment"];
    readonly acquire?: PreviewAccessControllerDependencies["tailnet"]["acquire"];
    readonly renew?: PreviewAccessControllerDependencies["tailnet"]["renew"];
    readonly release?: PreviewAccessControllerDependencies["tailnet"]["release"];
    readonly setPortEnabled?: PreviewAccessControllerDependencies["tailnet"]["setPortEnabled"];
    readonly prepareDesktop?: PreviewAccessControllerDependencies["prepareDesktop"];
    readonly timers?: PreviewAccessControllerDependencies["timers"];
    readonly now?: PreviewAccessControllerDependencies["now"];
  } = {},
) {
  return {
    surface: input.surface ?? "web",
    readEnvironment: input.readEnvironment ?? vi.fn(() => input.environment ?? environment()),
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
    now: input.now ?? (() => Date.parse("2026-09-02T11:59:00.000Z")),
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

  it("cancels a pending renewal retry when opt-in is disabled", async () => {
    const timers = manualTimers();
    let currentEnvironment = environment();
    const renew = vi.fn().mockRejectedValueOnce(new Error("socket closed"));
    const deps = dependencies({
      readEnvironment: () => currentEnvironment,
      renew,
      timers: timers.api,
      now: timers.now,
    });
    const controller = createPreviewAccessController(deps);

    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await timers.advanceBy(45_000);
    expect(timers.size()).toBe(1);

    currentEnvironment = environment({ tailscalePreviewsEnabled: false });
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    expect(timers.size()).toBe(0);
    await timers.advanceBy(15_000);
    expect(deps.tailnet.acquire).toHaveBeenCalledOnce();
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

  it("applies disappearance grace while the first automatic acquisition is pending", async () => {
    const timers = manualTimers();
    let resolveAcquire!: (result: PreviewTailnetAcquireResult) => void;
    const acquire = vi.fn(
      () => new Promise<PreviewTailnetAcquireResult>((resolve) => (resolveAcquire = resolve)),
    );
    const release = vi.fn(async () => undefined);
    const controller = createPreviewAccessController(
      dependencies({ acquire, release, timers: timers.api, now: timers.now }),
    );

    const acquiring = controller.reconcile({
      environmentId,
      threadId,
      servers: [server(5173)],
    });
    await controller.reconcile({ environmentId, threadId, servers: [] });
    expect(timers.delays()).toContain(15_000);

    await timers.advanceBy(10_000);
    resolveAcquire(tailnetResult(5173));
    await acquiring;
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toMatchObject({
      state: "disappearing",
    });
    expect(release).not.toHaveBeenCalled();

    await timers.advanceBy(5_000);
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
  });

  it("releases a late first acquisition after its disappearance grace has elapsed", async () => {
    const timers = manualTimers();
    let resolveAcquire!: (result: PreviewTailnetAcquireResult) => void;
    const acquire = vi.fn(
      () => new Promise<PreviewTailnetAcquireResult>((resolve) => (resolveAcquire = resolve)),
    );
    const release = vi.fn(async () => undefined);
    const controller = createPreviewAccessController(
      dependencies({ acquire, release, timers: timers.api, now: timers.now }),
    );

    const acquiring = controller.reconcile({
      environmentId,
      threadId,
      servers: [server(5173)],
    });
    await controller.reconcile({ environmentId, threadId, servers: [] });
    await timers.advanceBy(15_000);
    resolveAcquire(tailnetResult(5173));
    await acquiring;

    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "idle",
    });
  });

  it("cancels pending-acquisition disappearance grace when the port is rediscovered", async () => {
    const timers = manualTimers();
    let resolveAcquire!: (result: PreviewTailnetAcquireResult) => void;
    const acquire = vi.fn(
      () => new Promise<PreviewTailnetAcquireResult>((resolve) => (resolveAcquire = resolve)),
    );
    const release = vi.fn(async () => undefined);
    const controller = createPreviewAccessController(
      dependencies({ acquire, release, timers: timers.api, now: timers.now }),
    );

    const acquiring = controller.reconcile({
      environmentId,
      threadId,
      servers: [server(5173)],
    });
    await controller.reconcile({ environmentId, threadId, servers: [] });
    const rediscovered = controller.reconcile({
      environmentId,
      threadId,
      servers: [server(5173)],
    });
    resolveAcquire(tailnetResult(5173));
    await Promise.all([acquiring, rediscovered]);
    await timers.advanceBy(15_000);

    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toMatchObject({
      state: "active",
    });
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

  it.each([
    [
      "missing lease",
      new PreviewTailnetLeaseNotFoundError({ leaseId: "lease-5173" }),
      "gateway-failed",
    ],
    ["transport failure", new Error("socket closed"), "gateway-failed"],
    ["readiness failure", { readiness: "tailscale-unavailable" }, "tailscale-unavailable"],
  ] as const)(
    "releases stale state and retries a %s renewal failure",
    async (_name, failure, readiness) => {
      const timers = manualTimers();
      const renew = vi.fn().mockRejectedValueOnce(failure);
      const release = vi.fn(async () => undefined);
      const deps = dependencies({ renew, release, timers: timers.api, now: timers.now });
      const controller = createPreviewAccessController(deps);

      await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
      await timers.advanceBy(45_000);

      expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
      expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
        state: "unavailable",
        readiness,
      });
      expect(timers.size()).toBe(1);
      expect(timers.delays()[0]).toBeGreaterThanOrEqual(1_000);

      await timers.advanceBy(timers.delays()[0] ?? 0);
      expect(deps.tailnet.acquire).toHaveBeenCalledTimes(2);
      expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toMatchObject({
        state: "active",
      });
    },
  );

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

  it("revokes a late fresh launch when explicit disable wins the same port", async () => {
    let resolveAcquire!: (result: PreviewTailnetAcquireResult) => void;
    const acquire = vi.fn(
      () => new Promise<PreviewTailnetAcquireResult>((resolve) => (resolveAcquire = resolve)),
    );
    const release = vi.fn(
      async (_input: { readonly environmentId: EnvironmentId; readonly leaseId: string }) =>
        undefined,
    );
    const controller = createPreviewAccessController(dependencies({ acquire, release }));

    const preparing = controller.prepare({
      environmentId,
      threadId,
      target: { kind: "url", url: "http://localhost:5173/app" },
    });
    const disabling = controller.setPortEnabled({
      environmentId,
      threadId,
      port: 5173,
      enabled: false,
    });
    resolveAcquire(tailnetResult(5173));

    await expect(preparing).resolves.toMatchObject({
      state: "unavailable",
      readiness: "disabled",
    });
    await disabling;
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "suppressed",
    });
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
  });

  it("keeps suppression for metadata-only changes in the same observed process", async () => {
    const deps = dependencies();
    const controller = createPreviewAccessController(deps);
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await controller.setPortEnabled({ environmentId, threadId, port: 5173, enabled: false });
    vi.mocked(deps.tailnet.acquire).mockClear();
    vi.mocked(deps.tailnet.setPortEnabled).mockClear();

    await controller.reconcile({
      environmentId,
      threadId,
      servers: [
        server(5173, threadId, { processName: "vite dev", url: "http://localhost:5173/new" }),
      ],
    });

    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "suppressed",
    });
    expect(deps.tailnet.acquire).not.toHaveBeenCalled();
    expect(deps.tailnet.setPortEnabled).not.toHaveBeenCalled();
  });

  it("re-enables a suppressed port when a known PID is replaced", async () => {
    const deps = dependencies();
    const controller = createPreviewAccessController(deps);
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await controller.setPortEnabled({ environmentId, threadId, port: 5173, enabled: false });
    vi.mocked(deps.tailnet.acquire).mockClear();
    vi.mocked(deps.tailnet.setPortEnabled).mockClear();

    await controller.reconcile({
      environmentId,
      threadId,
      servers: [server(5173, threadId, { pid: 9999 })],
    });

    expect(deps.tailnet.setPortEnabled).toHaveBeenCalledWith({
      environmentId,
      threadId,
      port: 5173,
      enabled: true,
    });
    expect(deps.tailnet.acquire).toHaveBeenCalledOnce();
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toMatchObject({
      state: "active",
    });
  });

  it("re-enables a suppressed port after disappearance and reappearance", async () => {
    const deps = dependencies();
    const controller = createPreviewAccessController(deps);
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await controller.setPortEnabled({ environmentId, threadId, port: 5173, enabled: false });
    await controller.reconcile({ environmentId, threadId, servers: [] });
    vi.mocked(deps.tailnet.acquire).mockClear();
    vi.mocked(deps.tailnet.setPortEnabled).mockClear();

    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });

    expect(deps.tailnet.setPortEnabled).toHaveBeenCalledWith({
      environmentId,
      threadId,
      port: 5173,
      enabled: true,
    });
    expect(deps.tailnet.acquire).toHaveBeenCalledOnce();
  });

  it("observes suppressed-process disappearance while publication is opted out", async () => {
    let currentEnvironment = environment();
    const deps = dependencies({ readEnvironment: () => currentEnvironment });
    const controller = createPreviewAccessController(deps);
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    await controller.setPortEnabled({ environmentId, threadId, port: 5173, enabled: false });

    currentEnvironment = environment({ tailscalePreviewsEnabled: false });
    await controller.reconcile({ environmentId, threadId, servers: [] });
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "idle",
    });

    currentEnvironment = environment();
    vi.mocked(deps.tailnet.acquire).mockClear();
    vi.mocked(deps.tailnet.setPortEnabled).mockClear();
    await controller.reconcile({ environmentId, threadId, servers: [server(5173)] });
    expect(deps.tailnet.setPortEnabled).toHaveBeenCalledWith({
      environmentId,
      threadId,
      port: 5173,
      enabled: true,
    });
    expect(deps.tailnet.acquire).toHaveBeenCalledOnce();
  });

  it("reacts to unchanged-port opt-in and status transitions", async () => {
    let currentEnvironment = environment({ tailscalePreviewsEnabled: false });
    const release = vi.fn(async () => undefined);
    const deps = dependencies({
      readEnvironment: () => currentEnvironment,
      release,
    });
    const controller = createPreviewAccessController(deps);
    const servers = [server(5173)];

    await controller.reconcile({ environmentId, threadId, servers });
    expect(deps.tailnet.acquire).not.toHaveBeenCalled();

    currentEnvironment = environment({ tailscalePreviewsEnabled: true });
    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "tailscale-unavailable" },
    });
    expect(deps.tailnet.acquire).not.toHaveBeenCalled();

    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "ready" },
    });
    expect(deps.tailnet.acquire).toHaveBeenCalledOnce();

    currentEnvironment = environment({ tailscalePreviewsEnabled: false });
    await controller.reconcile({ environmentId, threadId, servers });
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
  });

  it("releases an active lease on status failure and reacquires after recovery", async () => {
    const timers = manualTimers();
    const release = vi.fn(async () => undefined);
    const deps = dependencies({ release, timers: timers.api, now: timers.now });
    const controller = createPreviewAccessController(deps);
    const servers = [server(5173)];

    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "ready" },
    });
    expect(timers.size()).toBe(1);

    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { state: "error", readiness: "gateway-failed" },
    });
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-5173" });
    expect(timers.size()).toBe(0);
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "unavailable",
      readiness: "gateway-failed",
    });

    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "ready" },
    });
    expect(deps.tailnet.acquire).toHaveBeenCalledTimes(2);
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toMatchObject({
      state: "active",
    });
  });

  it("waits out an invalidated acquisition before recovery starts a fresh generation", async () => {
    const timers = manualTimers();
    let resolveAcquireA!: (result: PreviewTailnetAcquireResult) => void;
    let resolveAcquireB!: (result: PreviewTailnetAcquireResult) => void;
    const acquireA = new Promise<PreviewTailnetAcquireResult>(
      (resolve) => (resolveAcquireA = resolve),
    );
    const acquireB = new Promise<PreviewTailnetAcquireResult>(
      (resolve) => (resolveAcquireB = resolve),
    );
    const acquire = vi
      .fn<PreviewAccessControllerDependencies["tailnet"]["acquire"]>()
      .mockImplementationOnce(() => acquireA)
      .mockImplementationOnce(() => acquireB);
    const release = vi.fn(async () => undefined);
    const deps = dependencies({ acquire, release, timers: timers.api, now: timers.now });
    const controller = createPreviewAccessController(deps);
    const servers = [server(5173)];

    const first = controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "ready" },
    });
    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { state: "error", readiness: "gateway-failed" },
    });
    const recovered = controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "ready" },
    });
    expect(acquire).toHaveBeenCalledOnce();

    resolveAcquireA({
      ...tailnetResult(5173),
      leaseId: "lease-a",
      cleanUrl: "https://machine.tailnet.ts.net:5173/from-a",
    });
    await first;
    await Promise.resolve();
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-a" });
    expect(acquire).toHaveBeenCalledTimes(2);

    resolveAcquireB({
      ...tailnetResult(5173),
      leaseId: "lease-b",
      cleanUrl: "https://machine.tailnet.ts.net:5173/from-b",
    });
    await recovered;
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toMatchObject({
      state: "active",
      cleanUrl: "https://machine.tailnet.ts.net:5173/from-b",
    });
    expect(release).not.toHaveBeenCalledWith({ environmentId, leaseId: "lease-b" });

    await timers.fireAll();
    expect(deps.tailnet.renew).toHaveBeenCalledOnce();
  });

  it.each([
    ["status failure", { state: "error", readiness: "gateway-failed" }],
    ["unready status", { enabled: true, readiness: "tailscale-unavailable" }],
  ] as const)("preserves explicit suppression through %s and recovery", async (_name, outage) => {
    const deps = dependencies();
    const controller = createPreviewAccessController(deps);
    const servers = [server(5173)];
    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "ready" },
    });
    await controller.setPortEnabled({ environmentId, threadId, port: 5173, enabled: false });
    vi.mocked(deps.tailnet.acquire).mockClear();

    await controller.reconcile({ environmentId, threadId, servers, status: outage });
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "suppressed",
    });

    await controller.reconcile({
      environmentId,
      threadId,
      servers,
      status: { enabled: true, readiness: "ready" },
    });
    expect(controller.getPortState({ environmentId, threadId, port: 5173 })).toEqual({
      state: "suppressed",
    });
    expect(deps.tailnet.acquire).not.toHaveBeenCalled();
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
