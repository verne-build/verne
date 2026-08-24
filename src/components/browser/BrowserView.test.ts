// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  updateBrowserTab: vi.fn(),
}));

vi.mock("@/platform", () => ({ invoke: mocks.invoke }));
vi.mock("@/composables/useFilePanelTabs", () => ({ updateBrowserTab: mocks.updateBrowserTab }));
vi.mock("vue-sonner", () => ({ toast: { error: vi.fn() } }));

import BrowserView from "./BrowserView.vue";

type TestWebview = HTMLElement & {
  getWebContentsId(): number;
  getURL(): string;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
};

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe("BrowserView", () => {
  let app: ReturnType<typeof createApp>;
  let host: HTMLDivElement;

  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.invoke.mockReset();
    mocks.updateBrowserTab.mockReset();
    mocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "browser_favorites_list" || method === "browser_history_list") return [];
      if (method === "native_browser_can_go") return { back: false, forward: false };
      if (method === "native_browser_navigate") return (params as { url: string }).url;
      return undefined;
    });
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    app?.unmount();
    host.remove();
    document.body.replaceChildren();
  });

  it("flushes one first navigation after the webview becomes ready", async () => {
    app = createApp({
      render: () => h(BrowserView, {
        tabId: "browser:1",
        url: null,
        workspaceDir: "/repo",
        directoryId: "dir-1",
        scopeType: "directory",
        active: true,
        newTabMode: true,
      }),
    });
    app.mount(host);
    await flush();

    const input = host.querySelector<HTMLInputElement>('input[placeholder="Search or enter address"]')!;
    input.value = "example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(mocks.updateBrowserTab).toHaveBeenCalledTimes(1);
    expect(mocks.updateBrowserTab).toHaveBeenCalledWith("browser:1", {
      browserUrl: "https://example.com",
      label: "example.com",
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("native_browser_navigate", expect.anything());

    const webview = host.querySelector("webview") as TestWebview;
    webview.getWebContentsId = () => 71;
    webview.getURL = () => "about:blank";
    webview.openDevTools = vi.fn();
    webview.closeDevTools = vi.fn();
    webview.isDevToolsOpened = () => false;
    webview.dispatchEvent(new Event("dom-ready"));
    await flush();
    webview.dispatchEvent(new Event("dom-ready"));
    await flush();

    expect(mocks.updateBrowserTab).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.filter(([method]) => method === "native_browser_navigate")).toEqual([
      ["native_browser_navigate", { id: 71, url: "https://example.com" }],
    ]);
    const activeReports = mocks.invoke.mock.calls.filter(([method]) => method === "native_browser_set_active");
    expect(activeReports).toEqual([
      ["native_browser_set_active", { tabId: "browser:1", workspaceDir: "/repo" }],
      ["native_browser_set_active", { tabId: "browser:1", workspaceDir: "/repo" }],
    ]);
    expect(input.value).toBe("https://example.com");
  });

  it("focuses a blank address only after its tab becomes active", async () => {
    const active = ref(false);
    app = createApp({
      render: () => h(BrowserView, {
        tabId: "browser:2",
        url: null,
        workspaceDir: "/repo",
        directoryId: "dir-1",
        scopeType: "directory",
        active: active.value,
        newTabMode: true,
      }),
    });
    app.mount(host);
    await flush();

    const input = host.querySelector<HTMLInputElement>('input[placeholder="Search or enter address"]')!;
    expect(document.activeElement).not.toBe(input);

    active.value = true;
    await flush();

    expect(document.activeElement).toBe(input);
  });

  it("unregisters the exact guest and ignores a stale registration continuation after unmount", async () => {
    let finishRegistration!: () => void;
    const registration = new Promise<void>((resolve) => { finishRegistration = resolve; });
    mocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "native_browser_register") return registration;
      if (method === "browser_favorites_list" || method === "browser_history_list") return [];
      if (method === "native_browser_can_go") return { back: false, forward: false };
      if (method === "native_browser_navigate") return (params as { url: string }).url;
      return undefined;
    });
    app = createApp({
      render: () => h(BrowserView, {
        tabId: "browser:stale",
        url: "https://example.com",
        workspaceDir: "/repo",
        directoryId: "dir-1",
        scopeType: "directory",
        active: true,
        newTabMode: false,
      }),
    });
    app.mount(host);
    await flush();
    const webview = host.querySelector("webview") as TestWebview;
    webview.getWebContentsId = () => 81;
    webview.getURL = () => "https://example.com";
    webview.openDevTools = vi.fn();
    webview.closeDevTools = vi.fn();
    webview.isDevToolsOpened = () => false;
    webview.dispatchEvent(new Event("dom-ready"));
    await flush();

    app.unmount();
    finishRegistration();
    await flush();

    expect(mocks.invoke).toHaveBeenCalledWith("native_browser_unregister", {
      tabId: "browser:stale", wcId: 81,
    });
    expect(mocks.invoke.mock.calls.filter(([method]) => method === "native_browser_set_active")).toEqual([]);
  });
});
