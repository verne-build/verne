import { describe, expect, it } from "vitest";
import { singlePaneResizeTargets } from "./paneLayout";
import type { LayoutNode } from "@/types";

const leaf = (pane: string): LayoutNode => ({ pane });
const split = (...panes: string[]): LayoutNode => ({
  direction: "h",
  children: panes.map(leaf),
  sizes: panes.map(() => 100 / panes.length),
});

describe("singlePaneResizeTargets", () => {
  it("targets every other single-pane group when the reporter is single-pane", () => {
    const layouts = [leaf("a"), leaf("b"), leaf("c")];
    expect(singlePaneResizeTargets(layouts, "a").sort()).toEqual(["b", "c"]);
  });

  it("excludes the reporter itself", () => {
    expect(singlePaneResizeTargets([leaf("a"), leaf("b")], "a")).toEqual(["b"]);
  });

  it("excludes split groups from the targets", () => {
    const layouts = [leaf("a"), split("b", "c"), leaf("d")];
    // b/c live in a split → sized per-pane on activation, never here.
    expect(singlePaneResizeTargets(layouts, "a")).toEqual(["d"]);
  });

  it("does nothing when the reporter is part of a split (not full-area)", () => {
    const layouts = [split("a", "b"), leaf("c")];
    expect(singlePaneResizeTargets(layouts, "a")).toEqual([]);
  });

  it("returns [] when the reporter isn't a known single pane", () => {
    expect(singlePaneResizeTargets([leaf("a")], "zzz")).toEqual([]);
  });
});
