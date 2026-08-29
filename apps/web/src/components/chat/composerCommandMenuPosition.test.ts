import { describe, expect, it } from "vite-plus/test";

import { resolveComposerCommandMenuPosition } from "./composerCommandMenuPosition";

describe("resolveComposerCommandMenuPosition", () => {
  it("matches the command menu to the full composer surface width", () => {
    expect(
      resolveComposerCommandMenuPosition({
        rect: { left: 120, top: 500, width: 768 },
        viewportHeight: 900,
        rootFontSizePx: 16,
      }),
    ).toEqual({
      bottom: 383,
      left: 120,
      maxHeight: 493,
      width: 768,
    });
  });
});
