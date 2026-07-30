import { describe, it, expect } from "vitest";
import { nextOverlayMode, overlayWidth } from "./overlaySidebar";

// contentMin 480, hysteresis 48 → enter below 480, leave at/above 528.
describe("nextOverlayMode", () => {
  it("keeps the current mode until the container is measured", () => {
    expect(nextOverlayMode(false, 0, 185)).toBe(false);
    expect(nextOverlayMode(true, 0, 185)).toBe(true);
  });

  it("stays docked while the content clears its floor", () => {
    expect(nextOverlayMode(false, 685, 185)).toBe(false);
  });

  it("enters overlay when the content would fall below its floor", () => {
    expect(nextOverlayMode(false, 664, 185)).toBe(true);
  });

  it("holds overlay inside the hysteresis band", () => {
    expect(nextOverlayMode(true, 685, 185)).toBe(true);
  });

  it("re-docks once past the hysteresis band", () => {
    expect(nextOverlayMode(true, 713, 185)).toBe(false);
  });

  it("triggers earlier for a wider sidebar", () => {
    expect(nextOverlayMode(false, 900, 600)).toBe(true);
    expect(nextOverlayMode(false, 900, 185)).toBe(false);
  });
});

describe("overlayWidth", () => {
  it("keeps the docked width when it fits", () => {
    expect(overlayWidth(200, 700)).toBe(200);
  });

  it("leaves a peek strip of content uncovered", () => {
    expect(overlayWidth(600, 500)).toBe(452);
  });

  it("never goes below the list minimum", () => {
    expect(overlayWidth(600, 200)).toBe(185);
  });

  it("passes the docked width through before measurement", () => {
    expect(overlayWidth(200, 0)).toBe(200);
  });
});
