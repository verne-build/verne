// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";

const selection = {
  agentType: "claude" as const,
  modelId: "opus",
  effort: "high",
  fast: true,
};
const store = vi.hoisted(() => ({
  cancelCenterSplitPicker: vi.fn(),
  startCenterSplitPicker: vi.fn(),
  isCenterSplitPickerLaunching: vi.fn(() => false),
}));

vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => store }));
vi.mock("./SessionLaunchControls.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { busy: Boolean, compact: Boolean },
      emits: ["start"],
      setup(_props, { emit }) {
        return () => h("button", {
          type: "button",
          "data-testid": "launch",
          onClick: () => emit("start", selection),
        }, "Start");
      },
    }),
  };
});

import CenterSplitSessionPicker from "./CenterSplitSessionPicker.vue";

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

describe("CenterSplitSessionPicker", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store.cancelCenterSplitPicker.mockReset();
    store.startCenterSplitPicker.mockReset();
    store.isCenterSplitPickerLaunching.mockReset();
    store.isCenterSplitPickerLaunching.mockReturnValue(false);
    store.startCenterSplitPicker.mockResolvedValue({ id: "session-b" });
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({
      render: () => h(CenterSplitSessionPicker, {
        directoryId: "dir-1",
        pickerId: "center-picker:test",
        sourceSessionId: "session-a",
      }),
    });
    app.mount(host);
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    document.body.replaceChildren();
  });

  it("shows a current-workspace New Session picker without branch or worktree controls", () => {
    expect(document.body.textContent).toContain("New Session");
    expect(document.body.textContent).not.toContain("Branch");
    expect(document.body.textContent).not.toContain("Worktree");
  });

  it("matches terminal title bars with the sidebar background", () => {
    const header = host.querySelector("header");
    expect(header?.classList.contains("bg-sidebar")).toBe(true);
  });

  it("aligns its close action with terminal title-bar actions", () => {
    const header = host.querySelector("header");
    const close = buttonByLabel("Close New Session");

    expect(header?.classList.contains("pr-1")).toBe(true);
    expect(header?.classList.contains("pl-4")).toBe(true);
    expect(close.dataset.size).toBe("icon-xs");
  });

  it("collapses the split from close or Escape while idle", async () => {
    buttonByLabel("Close New Session").click();
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();

    expect(store.cancelCenterSplitPicker).toHaveBeenCalledTimes(2);
    expect(store.cancelCenterSplitPicker).toHaveBeenNthCalledWith(1, "dir-1", "center-picker:test");
    expect(store.cancelCenterSplitPicker).toHaveBeenNthCalledWith(2, "dir-1", "center-picker:test");
    expect(document.activeElement).toBe(host.firstElementChild);
  });

  it("launches with the exact picker, source, and agent selection", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid=launch]")!.click();
    await flush();

    expect(store.startCenterSplitPicker).toHaveBeenCalledWith({
      directoryId: "dir-1",
      pickerId: "center-picker:test",
      sourceSessionId: "session-a",
      agentLaunch: selection,
    });
  });

  it("ignores close and Escape while launch is pending", async () => {
    let resolve!: (value: unknown) => void;
    store.startCenterSplitPicker.mockImplementation(() => new Promise((done) => { resolve = done; }));
    document.querySelector<HTMLButtonElement>("[data-testid=launch]")!.click();
    await nextTick();

    expect(buttonByLabel("Close New Session").disabled).toBe(true);
    buttonByLabel("Close New Session").click();
    host.firstElementChild?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(store.cancelCenterSplitPicker).not.toHaveBeenCalled();

    resolve({ id: "session-b" });
    await flush();
  });

  it("keeps the picker open with a retryable error when launch fails", async () => {
    store.startCenterSplitPicker.mockRejectedValueOnce(new Error("spawn failed"));
    document.querySelector<HTMLButtonElement>("[data-testid=launch]")!.click();
    await flush();

    expect(document.body.textContent).toContain("Couldn't Start Session");
    expect(document.body.textContent).toContain("spawn failed");
    expect(store.cancelCenterSplitPicker).not.toHaveBeenCalled();

    Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Retry")!
      .click();
    await flush();
    expect(store.startCenterSplitPicker).toHaveBeenCalledTimes(2);
    expect(store.startCenterSplitPicker).toHaveBeenLastCalledWith(expect.objectContaining({ agentLaunch: selection }));
  });
});
