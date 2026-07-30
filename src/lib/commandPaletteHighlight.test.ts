// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  commandPaletteNeedsInitialHighlight,
  commandPaletteResultsScrolled,
} from "./commandPalette";

describe("commandPaletteNeedsInitialHighlight", () => {
  it("preserves an existing highlight when live results refresh", () => {
    const listbox = document.createElement("div");
    const activeItem = document.createElement("div");
    activeItem.dataset.highlighted = "";
    listbox.append(activeItem);

    expect(commandPaletteNeedsInitialHighlight(listbox)).toBe(false);
  });

  it("requests an initial highlight when no result is active", () => {
    const listbox = document.createElement("div");

    expect(commandPaletteNeedsInitialHighlight(listbox)).toBe(true);
  });
});

describe("commandPaletteResultsScrolled", () => {
  it("keeps the filter divider hidden at the top", () => {
    expect(commandPaletteResultsScrolled(0)).toBe(false);
  });

  it("shows the filter divider after results scroll", () => {
    expect(commandPaletteResultsScrolled(0.5)).toBe(true);
  });
});
