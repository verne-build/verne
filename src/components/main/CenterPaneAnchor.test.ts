// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import CenterPaneAnchor from "./CenterPaneAnchor.vue";
import {
  centerPaneAnchorRegistryKey,
  createCenterPaneAnchorRegistry,
} from "./centerPaneAnchorRegistry";

const firstAnchorId = "center-pane:dir-1:session-a";
const secondAnchorId = "center-pane:dir-1:session-b";

describe("CenterPaneAnchor", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  const hosts: HTMLDivElement[] = [];

  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount();
    for (const host of hosts.splice(0)) host.remove();
  });

  function mount(registry = createCenterPaneAnchorRegistry(), anchorId = firstAnchorId) {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(CenterPaneAnchor, { anchorId }) });
    app.provide(centerPaneAnchorRegistryKey, registry);
    app.mount(host);
    apps.push(app);
    hosts.push(host);
    return { app, host, registry };
  }

  it("fills its parent, registers on mount, and unregisters on app unmount", () => {
    const { app, host, registry } = mount();
    const element = host.firstElementChild as HTMLElement;

    expect(element.dataset.centerPaneAnchor).toBe(firstAnchorId);
    expect(element.className).toBe("h-full w-full min-h-0 min-w-0 overflow-hidden");
    expect(registry.target(firstAnchorId)).toBe(element);

    app.unmount();

    expect(registry.target(firstAnchorId)).toBeNull();
  });

  it("preserves a newer target when an older app unmounts", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldMount = mount(registry);
    const newMount = mount(registry);
    const newElement = newMount.host.firstElementChild as HTMLElement;

    oldMount.app.unmount();

    expect(registry.target(firstAnchorId)).toBe(newElement);
  });

  it("moves the current element when anchorId changes", async () => {
    const registry = createCenterPaneAnchorRegistry();
    const anchorId = ref(firstAnchorId);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(CenterPaneAnchor, { anchorId: anchorId.value }) });
    app.provide(centerPaneAnchorRegistryKey, registry);
    app.mount(host);
    apps.push(app);
    hosts.push(host);
    const element = host.firstElementChild as HTMLElement;

    anchorId.value = secondAnchorId;
    await nextTick();

    expect(registry.target(firstAnchorId)).toBeNull();
    expect(registry.target(secondAnchorId)).toBe(element);
    expect(element.dataset.centerPaneAnchor).toBe(secondAnchorId);
  });
});
