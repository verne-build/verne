import { describe, expect, it } from "vitest";
import {
  deriveArrangement,
  parseArrangementMap,
  pruneArrangement,
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
});
