import { describe, it, expect } from "vitest";
import { reorderById } from "./reorderTabs";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("reorderById", () => {
  it("reorders to match the given id order", () => {
    expect(reorderById(items, ["c", "a", "b"])).toEqual([
      { id: "c" }, { id: "a" }, { id: "b" },
    ]);
  });
  it("ignores ids not present in the list", () => {
    expect(reorderById(items, ["c", "a", "b", "zzz"])).toEqual([
      { id: "c" }, { id: "a" }, { id: "b" },
    ]);
  });
  it("returns null when the id set does not cover every item", () => {
    expect(reorderById(items, ["a", "b"])).toBeNull();
  });
  it("returns the same membership, not the original reference", () => {
    const result = reorderById(items, ["a", "b", "c"]);
    expect(result).not.toBe(items);
    expect(result).toEqual(items);
  });
});
