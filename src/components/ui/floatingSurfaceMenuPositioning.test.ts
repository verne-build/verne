// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe("floating menu positioning", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("positions dropdown submenus outside the blurred parent surface", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () => h(DropdownMenu, { open: true }, {
        default: () => [
          h(DropdownMenuTrigger, null, { default: () => "Open" }),
          h(DropdownMenuContent, null, {
            default: () => h(DropdownMenuSub, { open: true }, {
              default: () => [
                h(DropdownMenuSubTrigger, null, { default: () => "More" }),
                h(DropdownMenuSubContent, null, { default: () => "Nested" }),
              ],
            }),
          }),
        ],
      }),
    });

    app.mount(host);
    await flush();

    const parent = document.querySelector<HTMLElement>("[data-slot=dropdown-menu-content]");
    const submenu = document.querySelector<HTMLElement>("[data-slot=dropdown-menu-sub-content]");
    expect(parent).not.toBeNull();
    expect(submenu).not.toBeNull();
    expect(parent!.contains(submenu)).toBe(false);

    app.unmount();
  });

  it("positions context submenus outside the blurred parent surface", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () => h(ContextMenu, null, {
        default: () => [
          h(ContextMenuTrigger, null, { default: () => "Open" }),
          h(ContextMenuContent, null, {
            default: () => h(ContextMenuSub, { open: true }, {
              default: () => [
                h(ContextMenuSubTrigger, null, { default: () => "More" }),
                h(ContextMenuSubContent, null, { default: () => "Nested" }),
              ],
            }),
          }),
        ],
      }),
    });

    app.mount(host);
    await flush();
    document.querySelector<HTMLElement>("[data-slot=context-menu-trigger]")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await flush();

    const parent = document.querySelector<HTMLElement>("[data-slot=context-menu-content]");
    const submenu = document.querySelector<HTMLElement>("[data-slot=context-menu-sub-content]");
    expect(parent).not.toBeNull();
    expect(submenu).not.toBeNull();
    expect(parent!.contains(submenu)).toBe(false);

    app.unmount();
  });
});
