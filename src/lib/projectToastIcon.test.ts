// @vitest-environment jsdom
import type { FunctionalComponent } from "vue";
import { createApp, h, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findFirstProjectToastIcon, projectToastIcon } from "./projectToastIcon";

let host: HTMLDivElement | undefined;
let app: ReturnType<typeof createApp> | undefined;

function renderIcon(icon: FunctionalComponent): HTMLImageElement {
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(icon) });
  app.mount(host);
  const image = host.querySelector("img");
  if (!image) throw new Error("Project toast icon did not render");
  return image;
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

describe("projectToastIcon", () => {
  it("renders a contained 20px project image with the shared outline", () => {
    const image = renderIcon(projectToastIcon("/project.png", true));

    expect(image.classList.contains("size-5")).toBe(true);
    expect(image.classList.contains("object-contain")).toBe(true);
    expect(image.classList.contains("rounded-xs")).toBe(true);
    expect(image.classList.contains("ring-1")).toBe(true);
    expect(image.classList.contains("ring-black/10")).toBe(true);
    expect(image.classList.contains("dark:ring-white/10")).toBe(true);
    expect(image.classList.contains("p-0.5")).toBe(true);
  });

  it("does not pad an opaque project image", () => {
    const image = renderIcon(projectToastIcon("/opaque.png", false));
    expect(image.classList.contains("p-0.5")).toBe(false);
  });
});

describe("findFirstProjectToastIcon", () => {
  it("skips missing icons and returns the first available project icon", async () => {
    const icons = ref<Record<string, string>>({});
    const transparentIcons = ref<Record<string, boolean>>({});
    const loadIcon = vi.fn(async (id: string) => {
      icons.value[id] = id === "second" ? "/second.png" : "";
      transparentIcons.value[id] = id === "second";
    });

    const icon = await findFirstProjectToastIcon([
      { id: "first", path: "/first" },
      { id: "second", path: "/second" },
      { id: "third", path: "/third" },
    ], { icons, transparentIcons, loadIcon });

    expect(loadIcon.mock.calls.map(([id]) => id)).toEqual(["first", "second"]);
    expect(renderIcon(icon!).src).toContain("/second.png");
  });

  it("returns no component when no directory has an icon", async () => {
    const icons = ref<Record<string, string>>({});
    const transparentIcons = ref<Record<string, boolean>>({});
    const loadIcon = vi.fn(async (id: string) => { icons.value[id] = ""; });

    const icon = await findFirstProjectToastIcon(
      [{ id: "empty", path: "/empty" }],
      { icons, transparentIcons, loadIcon },
    );

    expect(icon).toBeUndefined();
  });
});
