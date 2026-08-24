// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App, type Component } from "vue";
import { useShortcuts } from "@/composables/useShortcuts";
import { catalogDefaults } from "@/lib/shortcuts/catalog";

async function loadPicker(): Promise<Component | null> {
  const module = await import("./RightPanelPicker.vue").catch(() => null);
  return module?.default ?? null;
}

async function mountPicker() {
  const picker = await loadPicker();
  expect(picker).not.toBeNull();
  if (!picker) return null;

  const host = document.createElement("div");
  const open = vi.fn();
  document.body.append(host);
  const app = createApp({ render: () => h(picker, { onOpen: open }) });
  app.mount(host);
  await nextTick();

  return { app, host, open };
}

function rows(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("[data-picker-row]"));
}

describe("RightPanelPicker", () => {
  let app: App | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.replaceChildren();
    useShortcuts().registry.value = catalogDefaults();
  });

  it("renders the six openable tab rows and updates bound shortcut text", async () => {
    const mounted = await mountPicker();
    if (!mounted) return;
    app = mounted.app;

    const mac = /Mac/i.test(navigator.platform);
    expect(rows(mounted.host).map((row) => row.textContent?.trim())).toEqual([
      mac ? "Files⌘⇧E" : "FilesCtrlShiftE",
      mac ? "Source Control⌃⇧G" : "Source ControlCtrlShiftG",
      "History",
      "Search",
      "Notes",
      "Browser",
    ]);

    useShortcuts().registry.value = catalogDefaults().map((shortcut) =>
      shortcut.name === "focus-file-explorer" ? { ...shortcut, binding: "F" } : shortcut,
    );
    await nextTick();

    expect(rows(mounted.host)[0].textContent?.trim()).toBe("FilesF");
  });

  it("wraps focus between picker rows with ArrowUp and ArrowDown", async () => {
    const mounted = await mountPicker();
    if (!mounted) return;
    app = mounted.app;
    const pickerRows = rows(mounted.host);

    pickerRows[0].focus();
    pickerRows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(pickerRows[5]);

    pickerRows[5].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(pickerRows[0]);
  });

  it("keeps native Enter activation and emits the selected kind on clicks", async () => {
    const mounted = await mountPicker();
    if (!mounted) return;
    app = mounted.app;
    const pickerRows = rows(mounted.host);

    pickerRows[1].focus();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    expect(pickerRows[1].type).toBe("button");
    expect(pickerRows[1].dispatchEvent(enter)).toBe(true);
    pickerRows[1].click();
    pickerRows[5].click();

    expect(mounted.open).toHaveBeenNthCalledWith(1, "sourceControl");
    expect(mounted.open).toHaveBeenNthCalledWith(2, "browser");
  });
});
