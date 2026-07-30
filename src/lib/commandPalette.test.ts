import { describe, expect, it } from "vitest";
import { commandPaletteShowsAgents } from "./commandPalette";

describe("commandPaletteShowsAgents", () => {
  it("shows agents only in the unified palette", () => {
    expect(commandPaletteShowsAgents("all")).toBe(true);
    expect(commandPaletteShowsAgents("search")).toBe(false);
    expect(commandPaletteShowsAgents("command")).toBe(false);
    expect(commandPaletteShowsAgents("goto")).toBe(false);
  });
});
