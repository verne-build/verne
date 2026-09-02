import { describe, expect, it } from "vite-plus/test";

import { bottomDrawerTabItems, clampBottomDrawerHeight } from "./ThreadBottomDrawer";

describe("bottom drawer shell", () => {
  it("exposes accessible Terminal and Ports choices with one selected tab", () => {
    expect(bottomDrawerTabItems("ports")).toEqual([
      { id: "terminal", label: "Terminal", selected: false },
      { id: "ports", label: "Ports", selected: true },
    ]);
  });

  it("clamps resize heights to the usable viewport range", () => {
    expect(clampBottomDrawerHeight(120, 900)).toBe(180);
    expect(clampBottomDrawerHeight(500, 400)).toBe(300);
    expect(clampBottomDrawerHeight(Number.NaN, 900)).toBe(280);
  });
});
