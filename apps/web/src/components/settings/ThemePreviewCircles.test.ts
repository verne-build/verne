import { describe, expect, it } from "vite-plus/test";

import { getThemeColorsForMode, VERNE_THEME } from "../../themePalette";
import { STANDARD_THEME_CARDS } from "./ThemePreviewCircles";

describe("standard theme card", () => {
  it("presents Verne as the standard light and dark theme", () => {
    const card = STANDARD_THEME_CARDS[0]!;
    const light = getThemeColorsForMode(VERNE_THEME, "light")!;
    const dark = getThemeColorsForMode(VERNE_THEME, "dark")!;

    expect(card.label).toBe("Verne");
    expect(card.previews).toEqual([
      {
        mode: "light",
        colors: expect.objectContaining({ canvas: light.canvas, sidebar: light.sidebar }),
      },
      {
        mode: "dark",
        colors: expect.objectContaining({ canvas: dark.canvas, sidebar: dark.sidebar }),
      },
    ]);
  });
});
