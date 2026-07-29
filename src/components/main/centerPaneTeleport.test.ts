// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Teleport,
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  watch,
} from "vue";
import CenterPaneAnchor from "./CenterPaneAnchor.vue";
import {
  centerPaneAnchorRegistryKey,
  createCenterPaneAnchorRegistry,
} from "./centerPaneAnchorRegistry";

const anchorId = "center-pane:dir-1:session-a";

describe("center pane Teleport", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  const hosts: HTMLDivElement[] = [];

  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount();
    for (const host of hosts.splice(0)) host.remove();
  });

  it("retains a keyed terminal probe while its anchor is replaced", async () => {
    const registry = createCenterPaneAnchorRegistry();
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const layout = ref<"leaf" | "branch">("leaf");
    const target = ref<HTMLElement | null>(null);

    const Probe = defineComponent({
      setup() {
        return () => h("div", { "data-probe-root": "" }, [
          h("canvas", { "data-terminal-canvas": "" }),
          h("input", { "data-terminal-input": "" }),
        ]);
      },
      mounted,
      unmounted,
    });

    const Layout = defineComponent({
      setup() {
        watch(registry.revision, () => {
          target.value = registry.target(anchorId);
        }, { flush: "post", immediate: true });

        return () => h("main", [
          layout.value === "leaf"
            ? h(CenterPaneAnchor, { anchorId })
            : h("section", [h(CenterPaneAnchor, { anchorId })]),
          target.value
            ? h(Teleport, { to: target.value }, [h(Probe, { key: "session-a" })])
            : null,
        ]);
      },
    });

    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(Layout);
    app.provide(centerPaneAnchorRegistryKey, registry);
    app.mount(host);
    apps.push(app);
    hosts.push(host);
    await nextTick();

    const originalRoot = document.querySelector("[data-probe-root]");
    const originalCanvas = document.querySelector("[data-terminal-canvas]");
    const originalInput = document.querySelector("[data-terminal-input]") as HTMLInputElement;
    originalInput.focus();

    layout.value = "branch";
    await nextTick();

    expect(document.activeElement).toBe(document.body);
    registry.restoreCapturedFocus(anchorId);

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(document.querySelector("[data-probe-root]")).toBe(originalRoot);
    expect(document.querySelector("[data-terminal-canvas]")).toBe(originalCanvas);
    expect(document.querySelector("[data-terminal-input]")).toBe(originalInput);
    expect(document.activeElement).toBe(originalInput);

    layout.value = "leaf";
    await nextTick();

    expect(document.activeElement).toBe(document.body);
    registry.restoreCapturedFocus(anchorId);

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(document.querySelector("[data-probe-root]")).toBe(originalRoot);
    expect(document.querySelector("[data-terminal-canvas]")).toBe(originalCanvas);
    expect(document.querySelector("[data-terminal-input]")).toBe(originalInput);
    expect(document.activeElement).toBe(originalInput);

    app.unmount();

    expect(unmounted).toHaveBeenCalledTimes(1);
  });
});
