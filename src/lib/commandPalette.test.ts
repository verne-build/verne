import { describe, expect, it } from "vitest";
import {
  COMMAND_PALETTE_FILTERS,
  commandPaletteShowsActions,
  commandPaletteShowsAgents,
  commandPaletteShowsFiles,
  cycleCommandPaletteFilter,
  isSettingsCommand,
} from "./commandPalette";

describe("command palette filters", () => {
  it("exposes filters in display order", () => {
    expect(COMMAND_PALETTE_FILTERS).toEqual([
      { mode: "all", label: "All" },
      { mode: "agents", label: "Agents" },
      { mode: "search", label: "Files" },
      { mode: "command", label: "Actions" },
      { mode: "settings", label: "Settings" },
    ]);
  });

  it("maps modes to result sources", () => {
    expect(commandPaletteShowsFiles("all")).toBe(true);
    expect(commandPaletteShowsFiles("search")).toBe(true);
    expect(commandPaletteShowsFiles("agents")).toBe(false);
    expect(commandPaletteShowsAgents("all")).toBe(true);
    expect(commandPaletteShowsAgents("agents")).toBe(true);
    expect(commandPaletteShowsAgents("search")).toBe(false);
    expect(commandPaletteShowsActions("all")).toBe(true);
    expect(commandPaletteShowsActions("command")).toBe(true);
    expect(commandPaletteShowsActions("settings")).toBe(true);
    expect(commandPaletteShowsActions("agents")).toBe(false);
  });

  it("cycles filters in both directions with wrapping", () => {
    expect(cycleCommandPaletteFilter("all", 1)).toBe("agents");
    expect(cycleCommandPaletteFilter("all", -1)).toBe("settings");
    expect(cycleCommandPaletteFilter("settings", 1)).toBe("all");
    expect(cycleCommandPaletteFilter("agents", -1)).toBe("all");
  });

  it("classifies existing settings commands", () => {
    for (const id of [
      "view.settings", "view.theme", "ed.wrap", "ed.minimap",
      "ed.lineNumbers", "ed.sticky", "ed.mdPreview", "ed.mdEdit",
    ]) expect(isSettingsCommand(id)).toBe(true);
    expect(isSettingsCommand("view.explorer")).toBe(false);
    expect(isSettingsCommand("git.fetch")).toBe(false);
  });
});
