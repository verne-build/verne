// @vitest-environment jsdom
import type { App } from "vue";
import type { FloatingSurfaceVariant } from "@/components/ui/floatingSurface";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { toast } from "vue-sonner";
import Sonner from "./Sonner.vue";

let app: App<Element> | undefined;

async function renderToast(
  variant?: FloatingSurfaceVariant,
  buttons = false,
): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(Sonner, { variant }) });
  app.mount(host);
  toast("Material preview", {
    id: `material-${variant ?? "default"}`,
    duration: Infinity,
    closeButton: true,
    action: buttons ? { label: "Retry", onClick: () => {} } : undefined,
    cancel: buttons ? { label: "Dismiss", onClick: () => {} } : undefined,
  });
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  const element = document.querySelector<HTMLElement>("[data-sonner-toast]");
  if (!element) throw new Error("Toast did not render");
  return element;
}

afterEach(() => {
  toast.dismiss();
  app?.unmount();
  app = undefined;
  document.body.replaceChildren();
});

describe("Sonner floating surface", () => {
  it("uses glass by default", async () => {
    const element = await renderToast();
    expect(element.classList.contains("floating-surface-glass")).toBe(true);
    expect(element.classList.contains("floating-surface-toast")).toBe(true);
    expect(element.classList.contains("toast-interactive-controls")).toBe(true);
  });

  it("uses larger corners and a top-left close control", async () => {
    const element = await renderToast();
    const toaster = document.querySelector<HTMLElement>("[data-sonner-toaster]");
    const close = element.querySelector<HTMLElement>("[data-close-button]");

    expect(toaster?.style.getPropertyValue("--border-radius")).toBe("var(--radius-xl)");
    expect(toaster?.style.getPropertyValue("--toast-control-bg")).toBe("rgb(52 52 52)");
    expect(toaster?.style.getPropertyValue("--toast-control-fg")).toBe("var(--secondary-foreground)");
    expect(close?.dataset.closeButtonPosition).toBe("top-left");
    expect(close?.classList.contains("toast-overlay-control")).toBe(true);
    expect(close?.classList.contains("toast-session-active-close")).toBe(true);
  });

  it("supports the solid override", async () => {
    const element = await renderToast("solid");
    expect(element.classList.contains("floating-surface-solid")).toBe(true);
    expect(element.classList.contains("floating-surface-glass")).toBe(false);
  });

  it("uses a larger title", async () => {
    const title = (await renderToast()).querySelector<HTMLElement>("[data-title]");
    expect(title?.classList.contains("text-sm")).toBe(true);
  });

  it("uses the xs outline button treatment", async () => {
    const buttons = (await renderToast(undefined, true)).querySelectorAll<HTMLElement>("[data-button]");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.classList.contains("h-7")).toBe(true);
      expect(button.classList.contains("border")).toBe(true);
      expect(button.classList.contains("bg-background")).toBe(true);
      expect(button.classList.contains("shadow-xs")).toBe(true);
      expect(button.classList.contains("toast-overlay-control")).toBe(true);
      expect(button.classList.contains("toast-opaque-button")).toBe(true);
    }
  });
});
