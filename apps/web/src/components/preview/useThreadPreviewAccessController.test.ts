import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ThreadId,
  type DiscoveredLocalServer,
  type PreviewTailnetAcquireResult,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controllerFactory = vi.hoisted(() => ({
  create: vi.fn(),
}));

const hookState = vi.hoisted(() => ({
  tailnetEnabled: false,
  status: {
    data: null as { readonly enabled: boolean; readonly readiness: "ready" } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  servers: [] as ReadonlyArray<DiscoveredLocalServer>,
}));

const reactHooks = vi.hoisted(() => {
  type Cleanup = () => void;
  type Effect = () => void | Cleanup;
  type Slot =
    | { readonly kind: "memo"; deps: ReadonlyArray<unknown>; value: unknown }
    | { readonly kind: "ref"; value: { current: unknown } };

  let cursor = 0;
  let effects: Effect[] = [];
  let slots: Slot[] = [];
  const nextIndex = () => cursor++;
  const dependenciesEqual = (
    left: ReadonlyArray<unknown>,
    right: ReadonlyArray<unknown>,
  ): boolean =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

  return {
    beginRender() {
      cursor = 0;
      effects = [];
    },
    reset() {
      cursor = 0;
      effects = [];
      slots = [];
    },
    takeEffects(): Effect[] {
      return effects.splice(0);
    },
    useEffect(effect: Effect): void {
      nextIndex();
      effects.push(effect);
    },
    useMemo<A>(factory: () => A, deps: ReadonlyArray<unknown>): A {
      const index = nextIndex();
      const existing = slots[index];
      if (existing?.kind === "memo" && dependenciesEqual(existing.deps, deps)) {
        return existing.value as A;
      }
      const value = factory();
      slots[index] = { kind: "memo", deps, value };
      return value;
    },
    useRef<A>(initialValue: A): { current: A } {
      const index = nextIndex();
      const existing = slots[index];
      if (existing?.kind === "ref") return existing.value as { current: A };
      const value = { current: initialValue };
      slots[index] = { kind: "ref", value };
      return value;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: reactHooks.useEffect,
    useMemo: reactHooks.useMemo,
    useRef: reactHooks.useRef,
  };
});

vi.mock("~/browser/previewAccessController", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/browser/previewAccessController")>();
  return {
    ...actual,
    createDefaultPreviewAccessController: controllerFactory.create,
  };
});

vi.mock("~/portDiscoveryState", () => ({
  useDiscoveredPortsState: () => ({
    servers: hookState.servers,
    configuredUrlProbing: true,
  }),
}));

vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          environment: {
            capabilities: {
              tailnetPreviewPublishing: {
                protocolVersion: 1,
                requiredScope: "preview:access",
              },
            },
          },
          settings: { tailscalePreviewsEnabled: hookState.tailnetEnabled },
        },
      ],
    ]),
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    tailnetStatus: () => ({ kind: "tailnet-status" }),
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: { readonly kind?: string } | null) =>
    query?.kind === "tailnet-status"
      ? hookState.status
      : { data: null, error: null, isPending: false, refresh: vi.fn() },
}));

import {
  createPreviewAccessController,
  type PreviewAccessController,
  type PreviewAccessControllerDependencies,
} from "~/browser/previewAccessController";
import { useThreadPreviewAccessController } from "./useDiscoveredLocalServers";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const primaryTarget = new PrimaryConnectionTarget({
  environmentId,
  label: "Local",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

const tailnetResult = (port: number): PreviewTailnetAcquireResult => ({
  leaseId: `lease-${port}`,
  port,
  cleanUrl: `https://machine.tailnet.ts.net:${port}/app`,
  launchUrl: `https://machine.tailnet.ts.net:${port}/.well-known/verne-preview/auth#launch`,
  expiresAt: "2026-09-02T12:00:00.000Z",
  readiness: "ready",
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function renderHook(): {
  readonly controller: PreviewAccessController;
  readonly effects: Array<() => void | (() => void)>;
} {
  reactHooks.beginRender();
  const controller = useThreadPreviewAccessController({ environmentId, threadId });
  return { controller, effects: reactHooks.takeEffects() };
}

function replayStrictModeEffects(
  effects: ReadonlyArray<() => void | (() => void)>,
): Array<() => void> {
  const firstCleanups = effects.map((effect) => effect()).filter((value) => value !== undefined);
  for (const cleanup of firstCleanups) cleanup();
  return effects.map((effect) => effect()).filter((value) => value !== undefined);
}

describe("useThreadPreviewAccessController", () => {
  beforeEach(() => {
    reactHooks.reset();
    controllerFactory.create.mockReset();
    hookState.tailnetEnabled = false;
    hookState.status = { data: null, error: null, isPending: false, refresh: vi.fn() };
    hookState.servers = [
      {
        host: "localhost",
        connectHost: "127.0.0.1",
        port: 3210,
        url: "http://localhost:3210",
        processName: "vite",
        pid: 4210,
        terminal: { threadId, terminalId: "terminal-3210" },
      },
    ];
  });

  it("keeps automatic acquisition alive across StrictMode effect replay", async () => {
    const acquire = vi.fn(async ({ port }: { readonly port: number }) => tailnetResult(port));
    const release = vi.fn(async () => undefined);
    const dependencies = {
      surface: "web",
      readEnvironment: () => ({
        connection: { httpBaseUrl: "http://127.0.0.1:3773", target: primaryTarget },
        tailnetPreviewPublishing: { protocolVersion: 1, requiredScope: "preview:access" },
        tailscalePreviewsEnabled: hookState.tailnetEnabled,
      }),
      prepareDesktop: vi.fn(),
      tailnet: {
        status: vi.fn(async () => ({ enabled: true, readiness: "ready" as const })),
        acquire,
        renew: vi.fn(async ({ port }) => tailnetResult(port)),
        release,
        setPortEnabled: vi.fn(async () => ({ enabled: true, readiness: "ready" as const })),
      },
      timers: {
        setTimeout: vi.fn(() => Symbol("timer")),
        clearTimeout: vi.fn(),
      },
      now: () => Date.parse("2026-09-02T11:59:00.000Z"),
    } satisfies PreviewAccessControllerDependencies;
    const expectedController = createPreviewAccessController(dependencies);
    controllerFactory.create.mockReturnValue(expectedController);

    const initial = renderHook();
    const unmountCleanups = replayStrictModeEffects(initial.effects);
    await flushMicrotasks();
    expect(acquire).not.toHaveBeenCalled();

    hookState.tailnetEnabled = true;
    hookState.status = {
      data: { enabled: true, readiness: "ready" },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
    const ready = renderHook();
    ready.effects[0]?.();
    await flushMicrotasks();
    const automaticAcquireCalls = acquire.mock.calls.length;
    const prepareError = await ready.controller
      .prepare({
        environmentId,
        threadId,
        target: { kind: "environment-port", port: 3210 },
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(ready.controller).toBe(initial.controller);
    expect(automaticAcquireCalls).toBe(1);
    expect(prepareError).toBeNull();

    for (const cleanup of unmountCleanups) cleanup();
    await flushMicrotasks();
    await expect(
      ready.controller.prepare({
        environmentId,
        threadId,
        target: { kind: "environment-port", port: 3210 },
      }),
    ).rejects.toThrow("This preview access controller has been disposed.");
    expect(release).toHaveBeenCalledWith({ environmentId, leaseId: "lease-3210" });
  });
});
