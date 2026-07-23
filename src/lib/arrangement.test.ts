import { describe, expect, it } from "vitest";
import {
  applyArrangementSizes,
  deriveArrangement,
  insertIntoArrangement,
  migrateGroupsToArrangements,
  parseArrangementMap,
  pruneArrangement,
  removeFromArrangement,
  serializeArrangementMap,
  type Arrangement,
} from "./arrangement";
import type { LayoutNode } from "@/types";

const leaf = (id: string): LayoutNode => ({ pane: id });
const split = (a: string, b: string): LayoutNode => ({
  direction: "h",
  children: [leaf(a), leaf(b)],
  sizes: [50, 50],
});

describe("deriveArrangement", () => {
  it("wraps a layout at version 1", () => {
    expect(deriveArrangement(leaf("t1"))).toEqual({ version: 1, layout: { pane: "t1" } });
  });
  it("returns null for missing layout", () => {
    expect(deriveArrangement(undefined)).toBeNull();
    expect(deriveArrangement(null)).toBeNull();
  });
});

describe("pruneArrangement", () => {
  it("keeps fully-live arrangements intact", () => {
    const arr: Arrangement = { version: 1, layout: split("t1", "t2") };
    expect(pruneArrangement(arr, new Set(["t1", "t2"]))).toEqual(arr);
  });
  it("drops dead leaves and collapses the split", () => {
    const arr: Arrangement = { version: 1, layout: split("t1", "dead") };
    expect(pruneArrangement(arr, new Set(["t1"]))).toEqual({ version: 1, layout: { pane: "t1" } });
  });
  it("returns null when nothing survives", () => {
    const arr: Arrangement = { version: 1, layout: leaf("dead") };
    expect(pruneArrangement(arr, new Set())).toBeNull();
  });
});

describe("parse/serializeArrangementMap", () => {
  it("round-trips", () => {
    const map = { d1: { version: 1, layout: leaf("t1") } } as Record<string, Arrangement>;
    expect(parseArrangementMap(serializeArrangementMap(map))).toEqual(map);
  });
  it("returns {} on null, garbage, or wrong version", () => {
    expect(parseArrangementMap(null)).toEqual({});
    expect(parseArrangementMap("not json")).toEqual({});
    expect(parseArrangementMap(JSON.stringify({ d1: { version: 2, layout: leaf("t") } }))).toEqual({});
  });
  it("drops entries whose layout shape is malformed", () => {
    const raw = JSON.stringify({
      bad: { version: 1, layout: {} },
      good: { version: 1, layout: { pane: "t1" } },
    });
    expect(parseArrangementMap(raw)).toEqual({ good: { version: 1, layout: { pane: "t1" } } });
  });
  it("drops splits with malformed sizes (wrong arity / non-finite / non-number)", () => {
    const splitWithSizes = (sizes: unknown) => ({
      version: 1,
      layout: { direction: "h", children: [leaf("a"), leaf("b")], sizes },
    });
    const raw = JSON.stringify({
      short: splitWithSizes([50]),
      nan: splitWithSizes([50, Number.NaN]),
      str: splitWithSizes(["50", "50"]),
      ok: splitWithSizes([30, 70]),
    });
    expect(Object.keys(parseArrangementMap(raw))).toEqual(["ok"]);
  });
});

describe("insertIntoArrangement", () => {
  it("creates a solo arrangement from null", () => {
    expect(insertIntoArrangement(null, null, "t1", "h", false)).toEqual({
      version: 1, layout: { pane: "t1" },
    });
  });
  it("splits beside the anchor", () => {
    const arr: Arrangement = { version: 1, layout: leaf("t1") };
    expect(insertIntoArrangement(arr, "t1", "t2", "h", false)).toEqual({
      version: 1,
      layout: { direction: "h", children: [leaf("t1"), leaf("t2")], sizes: [50, 50] },
    });
  });
});

describe("removeFromArrangement", () => {
  it("collapses to the survivor", () => {
    const arr: Arrangement = { version: 1, layout: split("t1", "t2") };
    expect(removeFromArrangement(arr, "t2")).toEqual({ version: 1, layout: leaf("t1") });
  });
  it("null when last leaf removed", () => {
    expect(removeFromArrangement({ version: 1, layout: leaf("t1") }, "t1")).toBeNull();
  });
});

describe("applyArrangementSizes", () => {
  it("writes sizes into the matching internal node", () => {
    const arr: Arrangement = { version: 1, layout: split("t1", "t2") };
    expect(applyArrangementSizes(arr, "t1|t2", [40, 60])).toEqual({
      version: 1,
      layout: { direction: "h", children: [leaf("t1"), leaf("t2")], sizes: [40, 60] },
    });
  });
});

describe("migrateGroupsToArrangements", () => {
  it("active group's tree becomes the arrangement; order = group order then leaf order", () => {
    const g1 = { id: "g1", layout: JSON.stringify(split("t1", "t2")), activePaneId: "t2", sortOrder: 0, createdAt: 1 };
    const g2 = { id: "g2", layout: JSON.stringify(leaf("t3")), activePaneId: "t3", sortOrder: 1, createdAt: 2 };
    const out = migrateGroupsToArrangements({ d1: [g1, g2] }, { d1: "g1" });
    expect(out.arrangements.d1).toEqual({ version: 1, layout: split("t1", "t2") });
    expect(out.focusedByDir.d1).toBe("t2");
    expect(out.orderByDir.d1).toEqual(["t1", "t2", "t3"]);
  });

  it("falls back to the first group when the active id is unknown", () => {
    const g1 = { id: "g1", layout: JSON.stringify(split("t1", "t2")), activePaneId: "t2", sortOrder: 0, createdAt: 1 };
    const g2 = { id: "g2", layout: JSON.stringify(leaf("t3")), activePaneId: "t3", sortOrder: 1, createdAt: 2 };
    const out = migrateGroupsToArrangements({ d1: [g1, g2] }, { d1: "g?" });
    expect(out.arrangements.d1).toEqual({ version: 1, layout: split("t1", "t2") });
    expect(out.focusedByDir.d1).toBe("t2");
    expect(out.orderByDir.d1).toEqual(["t1", "t2", "t3"]);
  });
});
