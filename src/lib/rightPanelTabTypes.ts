import type { Component } from "vue";
import { Files, GitBranch, GitCompare, Search, PencilLine, Globe } from "@lucide/vue";
import type { OpenableTabKind } from "@/types";

export type RightPanelShortcutName = "focus-file-explorer" | "focus-source-control";

export interface RightPanelTabTypeEntry {
  kind: OpenableTabKind;
  label: "Files" | "Source Control" | "History" | "Search" | "Notes" | "Browser";
  icon: Component;
  shortcut?: RightPanelShortcutName;
}

export const TAB_TYPE_ENTRIES = [
  { kind: "explorer", label: "Files", icon: Files, shortcut: "focus-file-explorer" },
  { kind: "sourceControl", label: "Source Control", icon: GitBranch, shortcut: "focus-source-control" },
  { kind: "commits", label: "History", icon: GitCompare },
  { kind: "search", label: "Search", icon: Search },
  { kind: "notes", label: "Notes", icon: PencilLine },
  { kind: "browser", label: "Browser", icon: Globe },
] as const satisfies readonly RightPanelTabTypeEntry[];

export function tabTypeEntry(kind: OpenableTabKind): RightPanelTabTypeEntry {
  return TAB_TYPE_ENTRIES.find((entry) => entry.kind === kind)!;
}
