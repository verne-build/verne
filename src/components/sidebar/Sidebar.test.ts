// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

vi.mock("@/composables/useShortcuts", () => ({
  useShortcuts: () => ({ displayKeys: () => [] }),
}));
vi.mock("./SessionsSidebar.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ResourceMonitor.vue", () => ({
  default: { render: () => h("button") },
}));

import Sidebar from "./Sidebar.vue";

describe("Sidebar footer", () => {
  afterEach(() => document.body.replaceChildren());

  it("orders Resource Monitor before Keyboard Shortcuts and Settings", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(Sidebar) });
    app.mount(host);

    expect(
      Array.from(host.querySelectorAll("footer [data-control]"), (element) =>
        element.getAttribute("data-control"),
      ),
    ).toEqual(["resource-monitor", "keyboard-shortcuts", "settings"]);

    app.unmount();
  });
});
