// @vitest-environment jsdom
import type { App } from "vue";
import type { FloatingSurfaceVariant } from "@/components/ui/floatingSurface";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { toast } from "vue-sonner";
import Sonner from "./Sonner.vue";

let app: App<Element> | undefined;

async function renderToast(variant?: FloatingSurfaceVariant): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(Sonner, { variant }) });
  app.mount(host);
  toast("Material preview", { id: `material-${variant ?? "default"}`, duration: Infinity });
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
    expect((await renderToast()).classList.contains("floating-surface-glass")).toBe(true);
  });

  it("supports the solid override", async () => {
    const element = await renderToast("solid");
    expect(element.classList.contains("floating-surface-solid")).toBe(true);
    expect(element.classList.contains("floating-surface-glass")).toBe(false);
  });
});
