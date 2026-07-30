export type CommandPaletteMode = "all" | "search" | "command" | "goto";

export function commandPaletteShowsAgents(mode: CommandPaletteMode): boolean {
  return mode === "all";
}
