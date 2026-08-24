// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import type { TreeNode } from "@/composables/useFileTreeModel";
import FileTreeRow from "./FileTreeRow.vue";

vi.mock("@/composables/useFileIcon", () => ({
  resolveFileIconMask: () => ({ maskUrl: "url(file.svg)", token: "default" }),
}));

const fileNode: TreeNode = {
  path: "/repo/main.ts",
  name: "main.ts",
  isDir: false,
  isIgnored: false,
  depth: 0,
  parentPath: "/repo",
  childPaths: null,
  expanded: false,
};

describe("FileTreeRow", () => {
  let app: App | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.replaceChildren();
  });

  it("reports file promotion on the second click", async () => {
    const host = document.createElement("div");
    const rowClick = vi.fn();
    const rowDblClick = vi.fn();
    document.body.append(host);
    app = createApp({
      render: () => h(FileTreeRow, {
        node: fileNode,
        expanded: false,
        selected: false,
        renaming: false,
        renameValue: "",
        dragOver: false,
        dragLabel: "main.ts",
        onRowClick: rowClick,
        onRowDblClick: rowDblClick,
      }),
    });
    app.directive("focus", {});
    app.mount(host);
    await nextTick();
    const row = host.querySelector<HTMLElement>("[data-item-path]");
    expect(row).not.toBeNull();

    row?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(rowDblClick).not.toHaveBeenCalled();

    row?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(rowClick).toHaveBeenCalledTimes(2);
    expect(rowDblClick).toHaveBeenCalledOnce();
  });
});
