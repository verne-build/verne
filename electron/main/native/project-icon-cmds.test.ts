import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createFromPath: vi.fn() }));
vi.mock("electron", () => ({ nativeImage: { createFromPath: mocks.createFromPath } }));

import {
  bitmapHasMeaningfulTransparency,
  projectIconHasTransparentBackground,
} from "./project-icon-cmds";

function bitmap(alphas: number[]): Buffer {
  return Buffer.from(alphas.flatMap((alpha) => [0, 0, 0, alpha]));
}

describe("bitmapHasMeaningfulTransparency", () => {
  it("requires at least five percent pixels below 95 percent alpha", () => {
    expect(bitmapHasMeaningfulTransparency(bitmap(Array(19).fill(255).concat(242)))).toBe(true);
    expect(bitmapHasMeaningfulTransparency(bitmap(Array(20).fill(255).concat(242)))).toBe(false);
    expect(bitmapHasMeaningfulTransparency(bitmap([243]))).toBe(false);
  });

  it("treats an empty bitmap as opaque", () => {
    expect(bitmapHasMeaningfulTransparency(Buffer.alloc(0))).toBe(false);
  });

  it("treats SVG icons as transparent without native raster decoding", () => {
    expect(projectIconHasTransparentBackground("/project/favicon.svg")).toBe(true);
    expect(mocks.createFromPath).not.toHaveBeenCalled();
  });
});
