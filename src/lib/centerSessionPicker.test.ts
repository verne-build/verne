import { describe, expect, it } from "vitest";
import type { Arrangement } from "@/lib/arrangement";
import { collectPaneIds } from "@/lib/paneLayout";
import {
  containsCenterSessionPicker,
  insertCenterSessionPicker,
  isCenterSessionPickerId,
  newCenterSessionPickerId,
  persistedCenterArrangement,
  removeCenterSessionPicker,
  replaceCenterSessionPicker,
} from "@/lib/centerSessionPicker";

const base: Arrangement = { version: 1, layout: { pane: "session-a" } };
const picker = "center-picker:test";

describe("center session picker layout", () => {
  it("inserts, identifies, replaces, and removes a picker without changing the persisted layout", () => {
    const split = insertCenterSessionPicker(base, "session-a", picker, "h", false);

    expect(collectPaneIds(split.layout)).toEqual(["session-a", picker]);
    expect(isCenterSessionPickerId(picker)).toBe(true);
    expect(isCenterSessionPickerId("session-a")).toBe(false);
    expect(containsCenterSessionPicker(split.layout)).toBe(true);
    expect(containsCenterSessionPicker(split.layout, picker)).toBe(true);
    expect(persistedCenterArrangement(split)).toEqual(base);
    expect(collectPaneIds(replaceCenterSessionPicker(split, picker, "session-b")!.layout)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(removeCenterSessionPicker(split, picker)).toEqual(base);
  });

  it("collapses nested one-child splits when a picker is removed", () => {
    const nested: Arrangement = {
      version: 1,
      layout: {
        direction: "h",
        children: [
          { pane: "session-a" },
          {
            direction: "v",
            children: [{ pane: "session-b" }, { pane: picker }],
            sizes: [35, 65],
          },
        ],
        sizes: [40, 60],
      },
    };

    expect(removeCenterSessionPicker(nested, picker)).toEqual({
      version: 1,
      layout: {
        direction: "h",
        children: [{ pane: "session-a" }, { pane: "session-b" }],
        sizes: [40, 60],
      },
    });
  });

  it("replaces only the requested picker when multiple pickers are open", () => {
    const first = insertCenterSessionPicker(base, "session-a", "center-picker:first", "h", false);
    const both = insertCenterSessionPicker(first, "session-a", "center-picker:second", "v", false);
    const replaced = replaceCenterSessionPicker(both, "center-picker:first", "session-b");

    expect(replaced && collectPaneIds(replaced.layout)).toEqual([
      "session-a",
      "center-picker:second",
      "session-b",
    ]);
    expect(replaced && containsCenterSessionPicker(replaced.layout, "center-picker:second")).toBe(true);
  });

  it("filters every picker and preserves surviving sibling proportions", () => {
    const arrangement: Arrangement = {
      version: 1,
      layout: {
        direction: "h",
        children: [
          { pane: "session-a" },
          { pane: "center-picker:first" },
          { pane: "session-b" },
          { pane: "center-picker:second" },
        ],
        sizes: [20, 10, 50, 20],
      },
    };

    expect(persistedCenterArrangement(arrangement)).toEqual({
      version: 1,
      layout: {
        direction: "h",
        children: [{ pane: "session-a" }, { pane: "session-b" }],
        sizes: [28.57142857142857, 71.42857142857143],
      },
    });
  });

  it("returns null when an arrangement contains only picker leaves", () => {
    expect(persistedCenterArrangement({ version: 1, layout: { pane: picker } })).toBeNull();
  });

  it("generates reserved unique picker ids", () => {
    const first = newCenterSessionPickerId();
    const second = newCenterSessionPickerId();

    expect(first).toMatch(/^center-picker:/);
    expect(second).toMatch(/^center-picker:/);
    expect(second).not.toBe(first);
  });
});
