import { describe, expect, it } from "vitest";
import { bottomListRows, toHorizontal } from "./bottomList";
import type { LayoutNode } from "@/types";

const leaf = (id: string): LayoutNode => ({ pane: id });
const split = (...ids: string[]): LayoutNode => ({
  direction: "h",
  children: ids.map(leaf),
  sizes: ids.map(() => 100 / ids.length),
});

describe("bottomListRows", () => {
  it("emits one row for a solo group, carrying its pane id", () => {
    expect(bottomListRows(["g1"], () => leaf("p1"))).toEqual([
      { kind: "group", groupId: "g1", paneId: "p1", depth: 0 },
    ]);
  });

  it("expands a split group into indented pane rows in layout order", () => {
    const rows = bottomListRows(["g1"], () => split("p1", "p2"));
    expect(rows).toEqual([
      { kind: "group", groupId: "g1", paneId: "p1", depth: 0 },
      { kind: "pane", groupId: "g1", paneId: "p1", depth: 1 },
      { kind: "pane", groupId: "g1", paneId: "p2", depth: 1 },
    ]);
  });

  it("emits one pane row per leaf, in layout order", () => {
    const rows = bottomListRows(["g1"], () => split("p1", "p2", "p3"));
    expect(rows.filter((r) => r.kind === "pane").map((r) => r.paneId)).toEqual(["p1", "p2", "p3"]);
  });

  it("follows the given group order", () => {
    const layouts: Record<string, LayoutNode> = { g1: leaf("p1"), g2: leaf("p2") };
    expect(bottomListRows(["g2", "g1"], (id) => layouts[id]).map((r) => r.groupId)).toEqual(["g2", "g1"]);
  });

  it("skips a group whose arrangement is missing", () => {
    const layouts: Record<string, LayoutNode | null> = { g1: null, g2: leaf("p2") };
    expect(bottomListRows(["g1", "g2"], (id) => layouts[id] ?? null)).toEqual([
      { kind: "group", groupId: "g2", paneId: "p2", depth: 0 },
    ]);
  });

  it("returns nothing for no groups", () => {
    expect(bottomListRows([], () => null)).toEqual([]);
  });
});

describe("toHorizontal", () => {
  it("leaves a solo leaf unchanged", () => {
    expect(toHorizontal(leaf("p1"))).toEqual(leaf("p1"));
  });

  it("leaves a flat h-split unchanged", () => {
    const node = split("p1", "p2");
    expect(toHorizontal(node)).toEqual(node);
  });

  it("rewrites a flat v-split to h", () => {
    const node: LayoutNode = { direction: "v", children: [leaf("p1"), leaf("p2")], sizes: [50, 50] };
    expect(toHorizontal(node)).toEqual({
      direction: "h",
      children: [leaf("p1"), leaf("p2")],
      sizes: [50, 50],
    });
  });

  it("rewrites every v-split in a nested mix, preserving structure and sizes", () => {
    const node: LayoutNode = {
      direction: "v",
      children: [
        leaf("p1"),
        { direction: "h", children: [leaf("p2"), { direction: "v", children: [leaf("p3"), leaf("p4")], sizes: [40, 60] }], sizes: [30, 70] },
      ],
      sizes: [25, 75],
    };
    expect(toHorizontal(node)).toEqual({
      direction: "h",
      children: [
        leaf("p1"),
        { direction: "h", children: [leaf("p2"), { direction: "h", children: [leaf("p3"), leaf("p4")], sizes: [40, 60] }], sizes: [30, 70] },
      ],
      sizes: [25, 75],
    });
  });
});
