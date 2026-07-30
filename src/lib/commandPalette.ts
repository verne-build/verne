export type CommandPaletteMode =
  | "all" | "agents" | "search" | "command" | "settings" | "goto";
export type CommandPaletteFilterMode = Exclude<CommandPaletteMode, "goto">;

export const COMMAND_PALETTE_FILTERS = [
  { mode: "all", label: "All" },
  { mode: "agents", label: "Agents" },
  { mode: "search", label: "Files" },
  { mode: "command", label: "Actions" },
  { mode: "settings", label: "Settings" },
] as const satisfies readonly { mode: CommandPaletteFilterMode; label: string }[];

const SETTINGS_COMMAND_IDS = new Set([
  "view.settings", "view.theme", "ed.wrap", "ed.minimap",
  "ed.lineNumbers", "ed.sticky", "ed.mdPreview", "ed.mdEdit",
]);

export function commandPaletteShowsFiles(mode: CommandPaletteMode): boolean {
  return mode === "all" || mode === "search";
}

export function commandPaletteShowsAgents(mode: CommandPaletteMode): boolean {
  return mode === "all" || mode === "agents";
}

export function commandPaletteShowsActions(mode: CommandPaletteMode): boolean {
  return mode === "all" || mode === "command" || mode === "settings";
}

export function isSettingsCommand(id: string): boolean {
  return SETTINGS_COMMAND_IDS.has(id);
}

export function commandPaletteNeedsInitialHighlight(listbox: ParentNode): boolean {
  return !listbox.querySelector("[data-highlighted]");
}

export function commandPaletteResultsScrolled(scrollTop: number): boolean {
  return scrollTop > 0;
}

export function cycleCommandPaletteFilter(
  mode: CommandPaletteMode,
  direction: -1 | 1,
): CommandPaletteFilterMode {
  const index = COMMAND_PALETTE_FILTERS.findIndex((filter) => filter.mode === mode);
  const current = index === -1 ? 0 : index;
  return COMMAND_PALETTE_FILTERS[
    (current + direction + COMMAND_PALETTE_FILTERS.length) % COMMAND_PALETTE_FILTERS.length
  ].mode;
}
