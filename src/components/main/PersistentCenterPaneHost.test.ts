// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type Ref } from "vue";
import type { CenterPanePlacement } from "@/lib/centerPanePlacement";
import PersistentCenterPaneHost from "./PersistentCenterPaneHost.vue";
import {
  centerPaneAnchorRegistryKey,
  createCenterPaneAnchorRegistry,
  type CenterPaneAnchorRegistry,
} from "./centerPaneAnchorRegistry";

const nextTickControl = vi.hoisted(() => ({
  intercept: false,
  flushVue: null as null | (() => Promise<void>),
  pending: [] as Array<() => void>,
}));

const terminalLifecycle = vi.hoisted(() => ({
  mountOrder: [] as string[],
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
}));

vi.mock("vue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue")>();
  nextTickControl.flushVue = () => actual.nextTick();
  return {
    ...actual,
    nextTick: <T>(callback?: () => T) => {
      if (!nextTickControl.intercept) {
        const tick = actual.nextTick();
        return callback ? tick.then(callback) : tick;
      }
      return new Promise<T | void>((resolve) => {
        nextTickControl.pending.push(() => resolve(callback?.()));
      });
    },
  };
});

vi.mock("./TerminalPane.vue", async () => {
  const { defineComponent, h, onMounted, onUnmounted, ref } = await import("vue");

  return {
    default: defineComponent({
      name: "TerminalPaneProbe",
      props: {
        paneId: { type: String, required: true },
        scopeId: { type: String, required: true },
        focusedSessionId: String,
        multi: { type: Boolean, required: true },
        reserveLeftOverlay: Boolean,
        reserveRightOverlay: Boolean,
      },
      setup(props) {
        const findText = ref("");
        onMounted(() => {
          terminalLifecycle.mountOrder.push(props.paneId);
          terminalLifecycle.mounts.set(props.paneId, (terminalLifecycle.mounts.get(props.paneId) ?? 0) + 1);
        });
        onUnmounted(() => {
          terminalLifecycle.unmounts.set(props.paneId, (terminalLifecycle.unmounts.get(props.paneId) ?? 0) + 1);
        });

        return () => h("section", {
          "data-pane-id": props.paneId,
          "data-scope-id": props.scopeId,
          "data-focused-session-id": props.focusedSessionId,
          "data-multi": String(props.multi),
          "data-reserve-left-overlay": String(props.reserveLeftOverlay),
          "data-reserve-right-overlay": String(props.reserveRightOverlay),
        }, [
          h("div", { "data-terminal-scroll": "" }, [
            h("canvas", { "data-terminal-canvas": "" }),
            h("input", { "data-terminal-input": "" }),
            h("input", {
              "data-terminal-find": "",
              value: findText.value,
              onInput: (event: Event) => {
                findText.value = (event.target as HTMLInputElement).value;
              },
            }),
          ]),
        ]);
      },
    }),
  };
});

const anchorA = "center-pane:dir-1:session-a";
const anchorB = "center-pane:dir-1:session-b";

function placement(
  paneId: string,
  anchorId: string,
  overrides: Partial<CenterPanePlacement> = {},
): CenterPanePlacement {
  return {
    paneId,
    scopeId: "dir-1",
    anchorId,
    focusedSessionId: "session-a",
    multi: true,
    reserveLeftOverlay: false,
    reserveRightOverlay: false,
    ...overrides,
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  host: HTMLDivElement;
  placements: Ref<CenterPanePlacement[]>;
  registry: CenterPaneAnchorRegistry;
}

describe("PersistentCenterPaneHost", () => {
  const harnesses: Harness[] = [];

  beforeEach(() => {
    nextTickControl.intercept = false;
    nextTickControl.pending.length = 0;
    terminalLifecycle.mountOrder.length = 0;
    terminalLifecycle.mounts.clear();
    terminalLifecycle.unmounts.clear();
  });

  afterEach(() => {
    for (const { app } of harnesses.splice(0)) app.unmount();
    document.body.replaceChildren();
  });

  function registerTarget(registry: CenterPaneAnchorRegistry, anchorId: string): HTMLDivElement {
    const target = document.createElement("div");
    target.dataset.testAnchor = anchorId;
    document.body.append(target);
    registry.register(anchorId, target);
    return target;
  }

  function replaceTarget(registry: CenterPaneAnchorRegistry, anchorId: string): HTMLDivElement {
    const previous = registry.target(anchorId);
    const replacement = document.createElement("div");
    replacement.dataset.testAnchor = anchorId;
    document.body.append(replacement);
    if (previous) {
      registry.unregister(anchorId, previous);
      previous.remove();
    }
    registry.register(anchorId, replacement);
    return replacement;
  }

  function mount(initialPlacements: CenterPanePlacement[], registry = createCenterPaneAnchorRegistry()): Harness {
    const placements = ref(initialPlacements);
    const Root = defineComponent({
      setup: () => () => h(PersistentCenterPaneHost, { placements: placements.value }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(Root);
    app.provide(centerPaneAnchorRegistryKey, registry);
    app.mount(host);
    const harness = { app, host, placements, registry };
    harnesses.push(harness);
    return harness;
  }

  async function flushVue(): Promise<void> {
    if (!nextTickControl.flushVue) throw new Error("Missing real Vue nextTick");
    await nextTickControl.flushVue();
  }

  async function resolveNextHostTick(): Promise<void> {
    const resolve = nextTickControl.pending.shift();
    if (!resolve) throw new Error("Missing pending host nextTick");
    resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("mounts one terminal per depth-first placement and updates non-identity props in place", async () => {
    const registry = createCenterPaneAnchorRegistry();
    const targetA = registerTarget(registry, anchorA);
    registerTarget(registry, anchorB);
    const { placements } = mount([
      placement("session-a", anchorA),
      placement("session-b", anchorB),
    ], registry);
    await nextTick();

    const originalRoot = targetA.querySelector("[data-pane-id='session-a']");
    expect(terminalLifecycle.mountOrder).toEqual(["session-a", "session-b"]);
    expect(terminalLifecycle.mounts).toEqual(new Map([["session-a", 1], ["session-b", 1]]));

    placements.value = [
      placement("session-a", anchorA, {
        focusedSessionId: "session-b",
        multi: false,
        reserveLeftOverlay: true,
        reserveRightOverlay: true,
      }),
      placement("session-b", anchorB),
    ];
    await nextTick();

    const updatedRoot = targetA.querySelector<HTMLElement>("[data-pane-id='session-a']");
    expect(updatedRoot).toBe(originalRoot);
    expect(updatedRoot?.dataset.focusedSessionId).toBe("session-b");
    expect(updatedRoot?.dataset.multi).toBe("false");
    expect(updatedRoot?.dataset.reserveLeftOverlay).toBe("true");
    expect(updatedRoot?.dataset.reserveRightOverlay).toBe("true");
    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-a")).toBeUndefined();
  });

  it("moves original DOM and preserves focus, scroll, and local find state", async () => {
    const registry = createCenterPaneAnchorRegistry();
    const target = registerTarget(registry, anchorA);
    mount([placement("session-a", anchorA)], registry);
    await nextTick();

    const root = target.querySelector("[data-pane-id='session-a']");
    const canvas = target.querySelector("[data-terminal-canvas]");
    const input = target.querySelector<HTMLInputElement>("[data-terminal-input]")!;
    const scroll = target.querySelector<HTMLElement>("[data-terminal-scroll]")!;
    const find = target.querySelector<HTMLInputElement>("[data-terminal-find]")!;
    scroll.scrollTop = 137;
    find.value = "needle";
    find.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();

    const replacement = replaceTarget(registry, anchorA);
    await nextTick();
    await nextTick();

    expect(replacement.querySelector("[data-pane-id='session-a']")).toBe(root);
    expect(replacement.querySelector("[data-terminal-canvas]")).toBe(canvas);
    expect(replacement.querySelector("[data-terminal-input]")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect((replacement.querySelector("[data-terminal-scroll]") as HTMLElement).scrollTop).toBe(137);
    expect((replacement.querySelector("[data-terminal-find]") as HTMLInputElement).value).toBe("needle");
    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-a")).toBeUndefined();
  });

  it("accepts a detached parking target on first render", () => {
    const registry = createCenterPaneAnchorRegistry();
    const { host } = mount([placement("session-a", anchorA)], registry);
    const parking = host.querySelector<HTMLElement>("[data-center-pane-parking='true']")!;

    expect(parking).toBeTruthy();
    expect(parking.hidden).toBe(true);
    expect(parking.getAttribute("aria-hidden")).toBe("true");
    expect(parking.querySelector("[data-pane-id='session-a']")).toBeTruthy();
    expect(host.querySelector("[role='status']")).toBeNull();
  });

  it("parks a missing replacement target, reports it once, and moves when registered", async () => {
    const registry = createCenterPaneAnchorRegistry();
    const originalTarget = registerTarget(registry, anchorA);
    const { host } = mount([placement("session-a", anchorA)], registry);
    await nextTick();
    const originalRoot = originalTarget.querySelector("[data-pane-id='session-a']");
    const parking = host.querySelector<HTMLElement>("[data-center-pane-parking='true']")!;

    registry.unregister(anchorA, originalTarget);
    originalTarget.remove();
    await nextTick();

    expect(parking.querySelector("[data-pane-id='session-a']")).toBe(originalRoot);

    await nextTick();
    await nextTick();

    const statuses = host.querySelectorAll("[role='status']");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toBe(`Terminal pane unavailable: ${anchorA}`);

    const target = registerTarget(registry, anchorA);
    await nextTick();

    expect(host.querySelector("[role='status']")).toBeNull();
    expect(target.querySelector("[data-pane-id='session-a']")).toBeTruthy();
    expect(parking.querySelector("[data-pane-id='session-a']")).toBeNull();
    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
  });

  it("cancels an enqueued focus restore across an A-B-A placement replacement", async () => {
    const registry = createCenterPaneAnchorRegistry();
    const restoreCapturedFocus = vi.spyOn(registry, "restoreCapturedFocus");
    registerTarget(registry, anchorA);
    registerTarget(registry, anchorB);
    const { placements } = mount([placement("session-a", anchorA)], registry);
    await nextTick();

    nextTickControl.intercept = true;
    replaceTarget(registry, anchorA);
    await flushVue();

    expect(nextTickControl.pending).toHaveLength(1);

    placements.value = [placement("session-b", anchorB)];
    await flushVue();
    placements.value = [placement("session-a", anchorA)];
    await flushVue();
    await resolveNextHostTick();

    expect(restoreCapturedFocus).not.toHaveBeenCalledWith(anchorA);
  });

  it("cancels an enqueued missing-target retry across an A-B-A placement replacement", async () => {
    const registry = createCenterPaneAnchorRegistry();
    registerTarget(registry, anchorB);
    nextTickControl.intercept = true;
    const { host, placements } = mount([placement("session-a", anchorA)], registry);

    expect(nextTickControl.pending).toHaveLength(1);

    placements.value = [placement("session-b", anchorB)];
    await flushVue();
    placements.value = [placement("session-a", anchorA)];
    await flushVue();

    expect(nextTickControl.pending).toHaveLength(2);

    await resolveNextHostTick();
    await flushVue();

    expect(host.textContent).not.toContain(anchorA);
    expect(host.querySelector("[role='status']")).toBeNull();

    await resolveNextHostTick();
    await flushVue();

    expect(host.querySelector("[role='status']")?.textContent)
      .toBe(`Terminal pane unavailable: ${anchorA}`);
  });

  it("unmounts a removed session exactly once while retaining its sibling", async () => {
    const registry = createCenterPaneAnchorRegistry();
    registerTarget(registry, anchorA);
    registerTarget(registry, anchorB);
    const { placements } = mount([
      placement("session-a", anchorA),
      placement("session-b", anchorB),
    ], registry);
    await nextTick();

    placements.value = [placement("session-b", anchorB)];
    await nextTick();

    expect(terminalLifecycle.unmounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.mounts.get("session-b")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-b")).toBeUndefined();

  });

  it("replaces one session with another using one unmount and one mount", async () => {
    const registry = createCenterPaneAnchorRegistry();
    registerTarget(registry, anchorA);
    registerTarget(registry, anchorB);
    const { placements } = mount([placement("session-a", anchorA)], registry);
    await nextTick();

    placements.value = [placement("session-b", anchorB)];
    await nextTick();

    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.mounts.get("session-b")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-b")).toBeUndefined();
  });

  it("unmounts every remaining terminal and removes parking on host teardown", async () => {
    const registry = createCenterPaneAnchorRegistry();
    registerTarget(registry, anchorA);
    registerTarget(registry, anchorB);
    const { app, host } = mount([
      placement("session-a", anchorA),
      placement("session-b", anchorB),
    ], registry);
    await nextTick();
    const parking = host.querySelector("[data-center-pane-parking='true']")!;

    app.unmount();

    expect(terminalLifecycle.unmounts).toEqual(new Map([["session-a", 1], ["session-b", 1]]));
    expect(parking.isConnected).toBe(false);
  });

  it("preserves one component and the original canvas through 100 anchor replacements", async () => {
    const registry = createCenterPaneAnchorRegistry();
    let target = registerTarget(registry, anchorA);
    mount([placement("session-a", anchorA)], registry);
    await nextTick();
    const originalCanvas = target.querySelector("[data-terminal-canvas]");

    for (let cycle = 0; cycle < 100; cycle += 1) {
      target = replaceTarget(registry, anchorA);
      await nextTick();
      await nextTick();
      expect(target.querySelector("[data-terminal-canvas]")).toBe(originalCanvas);
    }

    expect(terminalLifecycle.mounts.get("session-a")).toBe(1);
    expect(terminalLifecycle.unmounts.get("session-a")).toBeUndefined();
  });
});
