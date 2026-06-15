import type { Component } from "vue";
import { toast } from "vue-sonner";
import {
  PanelLeft, PanelRight, Maximize2, Files, Settings, Palette,
  FolderOpen, SquareTerminal, GitFork, Target, Globe, ArrowRight, ArrowLeft, FilePlusCorner, X,
  SplitSquareHorizontal, SplitSquareVertical,
  RotateCcw, Save, Hash, MessageSquarePlus, WrapText, Map, ListOrdered, Pin, Eye, Pencil,
  GitCommitVertical, GitBranch, ArrowDownToLine, ArrowUpFromLine, RefreshCw, NotebookText,
} from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSettings } from "@/composables/useSettings";
import { useRpc } from "@/composables/useRpc";
import { useFilePanelTabs } from "@/composables/useFilePanelTabs";

// A palette command. `when` gates visibility against the current context
// (active editor, selected workspace). `shortcut` is display-only.
export interface Command {
  id: string;
  title: string;
  category: string;
  icon: Component;
  keywords?: string;
  shortcut?: string;
  when?: () => boolean;
  run: () => void | Promise<void>;
}

// App-level state (sidebars, themes, maximize) lives in App.vue — drive it
// through the existing menu-action bus rather than re-plumbing refs.
function menu(action: string, extra?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("menu-action", { detail: { action, ...extra } }));
}
function evt(name: string, detail?: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function useCommands() {
  const store = useWorkspaceStore();
  const { settings, update } = useSettings();
  const { request } = useRpc();
  const fp = useFilePanelTabs(() => store.activeRoot);

  const hasDir = () => !!store.selectedDirectory;
  const editorActive = () => fp.activeTab.value?.kind === "file";
  const repoPath = () => store.activeRoot?.path;

  async function gitOp(label: string, fn: () => Promise<string>) {
    try {
      const out = await fn();
      toast.success(label, out?.trim() ? { description: out.trim() } : undefined);
    } catch (e) {
      toast.error(`${label} failed`, { description: e instanceof Error ? e.message : String(e) });
    }
  }

  // Rebuilt per-call so labels/`when` reflect live settings + context.
  function list(): Command[] {
    const s = settings.value;
    return [
      // View
      { id: "view.toggleLeft", title: "Toggle Left Sidebar", category: "View", icon: PanelLeft, shortcut: "⌘B", keywords: "sidebar panel hide", run: () => menu("toggleLeftPanel") },
      { id: "view.toggleRight", title: "Toggle Right Panel", category: "View", icon: PanelRight, keywords: "sidebar editor hide", run: () => menu("toggleRightPanel") },
      { id: "view.maximize", title: "Maximize Editor Panel", category: "View", icon: Maximize2, when: hasDir, keywords: "fullscreen full", run: () => menu("toggleMaximize") },
      { id: "view.explorer", title: "Show File Explorer", category: "View", icon: Files, when: hasDir, keywords: "files tree reveal", run: () => menu("focusExplorer") },
      { id: "view.sc", title: "Show Source Control", category: "View", icon: GitBranch, when: hasDir, keywords: "git changes diff", run: () => menu("focusSourceControl") },
      { id: "view.notes", title: "Show Notes", category: "View", icon: NotebookText, when: hasDir, keywords: "notes notepad markdown scratchpad", run: () => menu("focusNotes") },
      { id: "view.settings", title: "Open Settings", category: "View", icon: Settings, shortcut: "⌘,", keywords: "preferences config", run: () => menu("openSettings") },
      { id: "view.theme", title: "Select Theme…", category: "View", icon: Palette, keywords: "color appearance", run: () => menu("openThemes") },

      // Workspace
      { id: "ws.open", title: "Open Workspace…", category: "Workspace", icon: FolderOpen, keywords: "add folder directory", run: () => menu("openWorkspace") },
      { id: "ws.newTerminal", title: "New Terminal", category: "Workspace", icon: SquareTerminal, when: hasDir, keywords: "tab shell", run: () => menu("newTerminal") },
      { id: "ws.splitRight", title: "Split Terminal Right", category: "Workspace", icon: SplitSquareHorizontal, shortcut: "⌘D", when: hasDir, keywords: "pane vertical side", run: () => menu("splitRight") },
      { id: "ws.splitDown", title: "Split Terminal Down", category: "Workspace", icon: SplitSquareVertical, shortcut: "⇧⌘D", when: hasDir, keywords: "pane horizontal stack", run: () => menu("splitDown") },
      { id: "ws.newWorktree", title: "New Worktree…", category: "Workspace", icon: GitFork, when: hasDir, keywords: "git branch", run: () => menu("newWorktree") },
      { id: "ws.scopeCurrent", title: "Agent Scope: Current Workspace", category: "Workspace", icon: Target, keywords: "filter agents", run: () => menu("setAgentScope", { scope: "current" }) },
      { id: "ws.scopeAll", title: "Agent Scope: All Workspaces", category: "Workspace", icon: Globe, keywords: "filter agents", run: () => menu("setAgentScope", { scope: "all" }) },

      // Tabs
      { id: "tab.next", title: "Next Tab", category: "Tabs", icon: ArrowRight, keywords: "switch cycle", run: () => menu("nextTab") },
      { id: "tab.prev", title: "Previous Tab", category: "Tabs", icon: ArrowLeft, keywords: "switch cycle", run: () => menu("prevTab") },
      { id: "tab.new", title: "New File", category: "Tabs", icon: FilePlusCorner, when: hasDir, keywords: "create", run: () => menu("newFile") },
      { id: "tab.close", title: "Close Tab", category: "Tabs", icon: X, shortcut: "⌘W", run: () => menu("closeTab") },
      { id: "tab.reopen", title: "Reopen Closed Tab", category: "Tabs", icon: RotateCcw, shortcut: "⇧⌘T", keywords: "restore", run: () => menu("reopenClosedTab") },

      // Editor
      { id: "ed.save", title: "Save", category: "Editor", icon: Save, shortcut: "⌘S", when: editorActive, keywords: "write", run: () => evt("editor-action", "save") },
      { id: "ed.gotoLine", title: "Go to Line…", category: "Editor", icon: Hash, shortcut: "⌃G", when: editorActive, keywords: "jump", run: () => evt("editor-goto-line") },
      { id: "ed.addAgent", title: "Add File to Agent", category: "Editor", icon: MessageSquarePlus, shortcut: "⇧⌘L", when: editorActive, keywords: "chat claude", run: () => evt("editor-action", "addToAgent") },
      { id: "ed.wrap", title: "Toggle Word Wrap", category: "Editor", icon: WrapText, keywords: "wrap lines", run: () => update({ editorWordWrap: !s.editorWordWrap }) },
      { id: "ed.minimap", title: "Toggle Minimap", category: "Editor", icon: Map, keywords: "overview", run: () => update({ editorMinimap: !s.editorMinimap }) },
      { id: "ed.lineNumbers", title: "Toggle Line Numbers", category: "Editor", icon: ListOrdered, keywords: "gutter", run: () => update({ editorLineNumbers: !s.editorLineNumbers }) },
      { id: "ed.sticky", title: "Toggle Sticky Scroll", category: "Editor", icon: Pin, keywords: "header", run: () => update({ editorStickyScroll: !s.editorStickyScroll }) },
      { id: "ed.mdPreview", title: "Markdown Default View: Preview", category: "Editor", icon: Eye, keywords: "render markdown", run: () => update({ markdownDefaultView: "preview" }) },
      { id: "ed.mdEdit", title: "Markdown Default View: Editor", category: "Editor", icon: Pencil, keywords: "source markdown", run: () => update({ markdownDefaultView: "edit" }) },

      // Git
      { id: "git.commit", title: "Source Control: Commit…", category: "Git", icon: GitCommitVertical, when: hasDir, keywords: "git message", run: () => menu("focusSourceControl") },
      { id: "git.branch", title: "Checkout Branch…", category: "Git", icon: GitBranch, when: hasDir, keywords: "git switch create", run: () => evt("open-branch-picker") },
      { id: "git.pull", title: "Git: Pull", category: "Git", icon: ArrowDownToLine, when: hasDir, run: () => { const p = repoPath(); if (p) void gitOp("Pull", () => request.gitPull({ path: p })); } },
      { id: "git.push", title: "Git: Push", category: "Git", icon: ArrowUpFromLine, when: hasDir, run: () => { const p = repoPath(); if (p) void gitOp("Push", () => request.gitPush({ path: p })); } },
      { id: "git.fetch", title: "Git: Fetch", category: "Git", icon: RefreshCw, when: hasDir, run: () => { const p = repoPath(); if (p) void gitOp("Fetch", () => request.gitFetch({ path: p })); } },
    ];
  }

  return { list };
}
