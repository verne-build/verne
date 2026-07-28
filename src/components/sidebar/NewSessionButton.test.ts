// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

vi.mock("@/composables/useShortcuts", () => ({
  useShortcuts: () => ({ displayKeys: () => ["⌘", "T"] }),
}));

import NewSessionButton from "./NewSessionButton.vue";

describe("NewSessionButton", () => {
  afterEach(() => document.body.replaceChildren());

  it("emits new-session when clicked", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onNewSession = vi.fn();
    const app = createApp({
      render: () => h(NewSessionButton, { onNewSession }),
    });
    app.mount(host);

    const button = host.querySelector<HTMLButtonElement>('button[aria-label="New Session"]');
    expect(button).not.toBeNull();
    button!.click();
    expect(onNewSession).toHaveBeenCalledOnce();

    app.unmount();
  });
});
