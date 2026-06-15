<script setup lang="ts">
import { defineAsyncComponent, provide, ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { listen, openExternal, invoke, convertFileSrc } from "./platform";
import { useProjectIcons } from "./composables/useProjectIcons";
import { useWorkspaceStore } from "./stores/workspace";
import { useRpc } from "./composables/useRpc";
import RightPanel from "./components/RightPanel.vue";
import ResourceMonitor from "./components/ResourceMonitor.vue";
import ThemeSelector from "./components/ThemeSelector.vue";
import { Toaster } from "./components/ui/sonner";
import { PanelLeft, FolderOpen, Check, Search } from "@lucide/vue";
import PanelLeftFilled from "./components/icons/PanelLeftFilled.vue";
import { Button } from "./components/ui/button";
import { Kbd, KbdGroup } from "./components/ui/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./components/ui/resizable";
import { useChordHint } from "./composables/useChordHint";
import { useFpsMeter } from "./composables/useFpsMeter";
import FpsMeter from "./components/FpsMeter.vue";
import { useFilePanelTabs } from "./composables/useFilePanelTabs";
import { useDiffHighlighter } from "./composables/useDiffHighlighter";
import {
  readCachedPanelState,
  writeCachedPanelPx,
  writeCachedSidebarCollapsed,
} from "@/lib/bootstrapCache";
import { PANEL_SIZES } from "@/lib/panelSizes";

import SettingsScreen from "./components/SettingsScreen.vue";
import SettingsSidebar from "./components/SettingsSidebar.vue";
import OpenInIdeButton from "@/components/OpenInIdeButton.vue";
import HeaderBranchPill from "@/components/HeaderBranchPill.vue";
import BranchPickerDialog from "@/components/BranchPickerDialog.vue";
import TabsCenter from "@/components/main/TabsCenter.vue";
import WelcomeHero from "@/components/main/WelcomeHero.vue";
import Sidebar from "@/components/sidebar/Sidebar.vue";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import { setSplitterDragging, flushTerminalLayouts } from "@/composables/useTerminal";
import { useWindowDrag } from "@/composables/useWindowDrag";
import DictationOverlay from "@/components/DictationOverlay.vue";
import DaemonRestartOverlay from "@/components/DaemonRestartOverlay.vue";
import { useDictation } from "@/composables/useDictation";
import { useShortcuts } from "@/composables/useShortcuts";
import { wireAgentNotifications, unwireAgentNotifications } from "@/composables/useAgentNotifications";
import { useSettingsScreen } from "@/composables/useSettingsScreen";
import { useAppUpdates } from "@/composables/useAppUpdates";

const dictation = useDictation();
const shortcuts = useShortcuts();
useAppUpdates();
const BttfEasterEgg = defineAsyncComponent(() => import("./components/BttfEasterEgg.vue"));

// Manual window-drag fallback for tab bars clipped by reka-ui resizable panels,
// where native -webkit-app-region: drag is dropped.
useWindowDrag();

const store = useWorkspaceStore();
watch(
  () => store.selectedDirectoryId,
  (dirId) => {
    if (dirId) void store.loadTabsForDirectory(dirId);
  },
  { immediate: true },
);
// No workspaces yet → full-screen onboarding, all chrome (sidebar/header/top
// controls) hidden. null once any workspace exists or one is selected.
const onboarding = computed<"hero" | "picker" | null>(() => {
  if (store.selectedDirectoryId) return null;
  if (!store.directoriesLoaded) return null;
  if (store.directories.length !== 0) return null;
  return store.welcomeSeen ? "picker" : "hero";
});
const showThemes = ref(false);
const { showSettings } = useSettingsScreen();
const showShortcuts = ref(false);
const showBttf = ref(false);
// Branch picker — opened from the command palette ("Checkout Branch…").
const branchPickerOpen = ref(false);
const branchPickerBranch = ref("");
const branchPickerPath = computed(() => store.activeRoot?.path ?? "");
async function openBranchPicker() {
  const path = store.activeRoot?.path;
  if (!path) return;
  try {
    branchPickerBranch.value = await useRpc().request.gitBranchName({ path });
  } catch {
    branchPickerBranch.value = "";
  }
  branchPickerOpen.value = true;
}
const cachedPanels = readCachedPanelState();
const leftCollapsed = ref(cachedPanels.leftCollapsed);
const rightCollapsed = ref(cachedPanels.rightCollapsed);
// File panel maximized — fills the inner area, hiding the terminal/agent center.
// Provided so the agents panel can clear it when an agent is focused.
const fileMaximized = ref(false);
provide("rightCollapsed", rightCollapsed);
provide("leftCollapsed", leftCollapsed);
provide("fileMaximized", fileMaximized);

// Persist sidebar collapse state
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
function persistCollapseState() {
  writeCachedSidebarCollapsed("left", leftCollapsed.value);
  writeCachedSidebarCollapsed("right", rightCollapsed.value);
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    const rpc = useRpc();
    rpc.request.setAppState({
      key: "sidebar_left_collapsed",
      value: leftCollapsed.value ? "true" : "false",
    });
    rpc.request.setAppState({
      key: "sidebar_right_collapsed",
      value: rightCollapsed.value ? "true" : "false",
    });
  }, 300);
}
watch(leftCollapsed, () => persistCollapseState());
watch(rightCollapsed, () => persistCollapseState());

// Sidebar collapse is a one-shot v-if change — the terminal container resizes
// in a single layout pass. The ResizeObserver's 100ms debounce would otherwise
// leave xterm at the old cols/rows for 100ms before snapping. Flush immediately
// after Vue applies the DOM change and the browser lays out the new size.
watch([leftCollapsed, rightCollapsed, fileMaximized], () => {
  requestAnimationFrame(() => flushTerminalLayouts());
  // Monaco's automaticLayout can miss these abrupt flex changes under WKWebView
  // (blank editor) — force an explicit remeasure once the layout settles.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("relayout-editors")),
    ),
  );
});
const showRight = computed(() => !!store.selectedDirectory);
// Maximize only makes sense while the file panel is visible — clear it when the
// panel is collapsed or there's no workspace, so the center can't be left blank.
watch([rightCollapsed, showRight], () => {
  if (rightCollapsed.value || !showRight.value) fileMaximized.value = false;
});
const displayedDirectory = computed(() => store.selectedDirectory);
const leftPanelRef = ref<any>(null);
const rightPanelRef = ref<any>(null);

watch([showSettings, leftCollapsed], () => {
  if (showSettings.value && leftCollapsed.value) leftCollapsed.value = false;
});
const { chordHint } = useChordHint();
const { toggle: toggleFpsMeter } = useFpsMeter();

const handleClass = "cursor-ew-resize";

const LEFT_PANEL_MIN_PX = PANEL_SIZES.left.min;
const LEFT_PANEL_MAX_PX = PANEL_SIZES.left.max;
const RIGHT_PANEL_MIN_PX = PANEL_SIZES.right.min;
const RIGHT_PANEL_MAX_PX = PANEL_SIZES.right.max;
const CENTER_PANEL_MIN_PX = PANEL_SIZES.center.min;

// The center is a flexible (%) panel so the px-sized right sidebar stays pinned
// when the window resizes (reka-ui pins px panels only when a % panel absorbs
// the delta). Its px floor is expressed as a % of the live inner-group width.
const mainAreaEl = ref<HTMLElement | null>(null);
const mainAreaWidth = ref(0);
const centerMinPct = computed(() => {
  const w = mainAreaWidth.value;
  if (!w) return 20;
  return Math.max(5, Math.min(90, (CENTER_PANEL_MIN_PX / w) * 100));
});
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const legacyPanelPx = (percent: number | null, fallback: number, min: number, max: number) =>
  clamp(percent == null ? fallback : (window.innerWidth * percent) / 100, min, max);

// Pixel-sized sidebars keep the user's width when the window changes; the
// percentage-sized center panels absorb the available-space delta.
const panelSizes = ref({
  left: clamp(
    cachedPanels.leftPx ?? legacyPanelPx(cachedPanels.left, PANEL_SIZES.left.default, LEFT_PANEL_MIN_PX, LEFT_PANEL_MAX_PX),
    LEFT_PANEL_MIN_PX,
    LEFT_PANEL_MAX_PX,
  ),
  right: clamp(
    cachedPanels.rightPx ?? legacyPanelPx(cachedPanels.right, PANEL_SIZES.right.default, RIGHT_PANEL_MIN_PX, RIGHT_PANEL_MAX_PX),
    RIGHT_PANEL_MIN_PX,
    RIGHT_PANEL_MAX_PX,
  ),
});
const filePanelTabs = useFilePanelTabs(() => store.activeRoot);
const panelSaveTimers: Partial<Record<"left" | "right", ReturnType<typeof setTimeout>>> = {};

// Outer layout: left sidebar vs rest
function onPanelLayout(sizes: number[]) {
  const leftMounted = !leftCollapsed.value;
  const leftIdx = leftMounted ? 0 : -1;
  const left = leftIdx >= 0 && sizes[leftIdx] > 0 ? sizes[leftIdx] : panelSizes.value.left;
  panelSizes.value = { ...panelSizes.value, left };
  if (leftIdx >= 0 && sizes[leftIdx] > 0) writeCachedPanelPx("left", left);
  if (panelSaveTimers.left) clearTimeout(panelSaveTimers.left);
  panelSaveTimers.left = setTimeout(() => {
    if (leftIdx >= 0 && sizes[leftIdx] > 0)
      useRpc().request.setAppState({ key: "panel_left_px", value: String(Math.round(left)) });
  }, 500);
}

// Inner layout: center vs merged panel
function onInnerLayout(sizes: number[]) {
  const rightMounted = showRight.value && !rightCollapsed.value;
  const rightIdx = rightMounted ? sizes.length - 1 : -1;
  const right = rightIdx >= 0 && sizes[rightIdx] > 0 ? sizes[rightIdx] : panelSizes.value.right;
  panelSizes.value = { ...panelSizes.value, right };
  if (rightIdx >= 0 && sizes[rightIdx] > 0) writeCachedPanelPx("right", right);
  if (panelSaveTimers.right) clearTimeout(panelSaveTimers.right);
  panelSaveTimers.right = setTimeout(() => {
    if (rightIdx >= 0 && sizes[rightIdx] > 0)
      useRpc().request.setAppState({ key: "panel_right_px", value: String(Math.round(right)) });
  }, 500);
}

const { icons: projectIcons, loadIcon: loadProjectIcon } = useProjectIcons();

watch(
  () => store.directories.length,
  () => {
    for (const d of store.directories) loadProjectIcon(d.id, d.path);
  },
  { immediate: true },
);

function displayPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

// Disable drag region while a dismissable layer (dropdown/popover) is open
// so pointer events reach the document and reka-ui can dismiss on outside click
const hasDismissableLayer = ref(false);
let dismissObserver: MutationObserver | null = null;
let mainAreaObserver: ResizeObserver | null = null;

function initMainAreaObserver() {
  if (!mainAreaEl.value || typeof ResizeObserver !== "function") return;
  mainAreaWidth.value = mainAreaEl.value.clientWidth;
  mainAreaObserver = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w) mainAreaWidth.value = w;
  });
  mainAreaObserver.observe(mainAreaEl.value);
}

function initDismissObserver() {
  dismissObserver = new MutationObserver(() => {
    hasDismissableLayer.value = document.querySelector("[data-dismissable-layer]") !== null;
  });
  dismissObserver.observe(document.body, { childList: true, subtree: true });
}

async function openSettings() {
  const rpc = useRpc();
  const path = await rpc.request.getSettingsPath({});
  window.dispatchEvent(new CustomEvent("open-file-tab", { detail: path }));
}

// Command palette / file search lives here (not in RightPanel) so its
// shortcuts work even when the right panel is collapsed/unmounted.
const showFileSearch = ref(false);
const fileSearchMode = ref<"all" | "search" | "command">("search");
function openFileFromPalette(path: string) {
  if (rightCollapsed.value) rightCollapsed.value = false;
  // Explicit quick-open selection → permanent tab, not a preview.
  filePanelTabs.openFile(path, undefined, { permanent: true });
}
function handleOpenFileSearch() { fileSearchMode.value = "search"; showFileSearch.value = true; }
function handleOpenCommandPalette() { fileSearchMode.value = "command"; showFileSearch.value = true; }
function handleOpenPaletteAll() { fileSearchMode.value = "all"; showFileSearch.value = true; }

function handleOpenFileTab(e: Event) {
  const detail = (e as CustomEvent<string | { path?: string; position?: { line?: number; column?: number } }>).detail;
  if (!detail) return;
  // Expand the right panel first if collapsed, so the file has somewhere to land.
  if (rightCollapsed.value) rightCollapsed.value = false;
  if (typeof detail === "string") {
    filePanelTabs.openFile(detail, undefined, { permanent: true });
    return;
  }
  if (!detail.path) return;
  const line = detail.position?.line;
  filePanelTabs.openFile(
    detail.path,
    line ? { line, column: detail.position?.column ?? 1 } : undefined,
    { permanent: true },
  );
}

async function openWorkspace() {
  await store.openAndSelectWorkspace();
}

async function newTerminal() {
  const dirId = store.selectedDirectoryId;
  if (!dirId) return;
  try {
    await store.createTab({ directoryId: dirId });
  } catch (e) {
    console.error("[App] newTerminal failed:", e);
  }
}

async function newWorktree() {
  const dir = store.selectedDirectory;
  if (!dir) return;
  // Worktrees nest under root dirs — if a worktree is selected, use its parent.
  const parentId = dir.parentDirectoryId ?? dir.id;
  try {
    const wt = await store.createWorktree(parentId, "");
    store.selectDirectory(wt);
    try { await store.createTab({ directoryId: wt.id }); } catch {}
  } catch (e) {
    window.alert(`Failed to create worktree: ${e}`);
  }
}

function cycleTab(dir: 1 | -1) {
  const dirId = store.selectedDirectoryId;
  if (!dirId) return;
  const tabs = store.terminalTabsByDirectory[dirId] ?? [];
  if (tabs.length < 2) return;
  const activeId = store.activeTabIdByDirectory[dirId];
  const idx = tabs.findIndex((t) => t.id === activeId);
  const next = tabs[(idx + dir + tabs.length) % tabs.length];
  store.setActiveTab(dirId, next.id);
}

// Activate terminal tab N (1-based) in the selected directory.
function selectTabByIndex(n: number) {
  const dirId = store.selectedDirectoryId;
  if (!dirId) return false;
  const tabs = store.terminalTabsByDirectory[dirId] ?? [];
  const tab = tabs[n - 1];
  if (!tab) return false;
  store.setActiveTab(dirId, tab.id);
  return true;
}

// ⌘W — close the focused tab: file tab if focus is in the file panel,
// otherwise the active terminal tab. Each owner applies its own close
// confirmation (dirty file / running process).
function closeActiveTab() {
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest("[data-file-panel]")) {
    window.dispatchEvent(new CustomEvent("close-active-file-tab"));
  } else {
    window.dispatchEvent(new CustomEvent("close-active-terminal-tab"));
  }
}

function newFile() {
  if (!store.selectedDirectory) return;
  if (rightCollapsed.value) rightCollapsed.value = false;
  // Wait a tick so a just-mounted RightPanel has registered its listener.
  void nextTick(() => window.dispatchEvent(new CustomEvent("new-file")));
}

function focusFilePanel(view: "sc" | "explorer" | "notes") {
  if (!store.selectedDirectory) return;
  if (rightCollapsed.value) rightCollapsed.value = false;
  void nextTick(() => window.dispatchEvent(new CustomEvent("focus-file-panel", { detail: view })));
}

function focusTerminal() {
  fileMaximized.value = false;
  window.dispatchEvent(new CustomEvent("terminal-action", { detail: "focus" }));
}

// Split the focused terminal pane. 'h' = side-by-side, 'v' = stacked.
function splitActivePane(direction: "h" | "v") {
  const dirId = store.selectedDirectoryId;
  if (!dirId) return;
  const paneId = store.activeTabIdByDirectory[dirId];
  if (paneId) void store.splitPane(paneId, direction);
}

function handleMenuAction(e: Event) {
  const detail = (e as CustomEvent).detail ?? {};
  const action = detail.action;
  if (action === "openSettings") showSettings.value = true;
  else if (action === "openWorkspace") void openWorkspace();
  else if (action === "newTerminal") void newTerminal();
  else if (action === "newWorktree") void newWorktree();
  else if (action === "toggleLeftPanel") leftCollapsed.value = !leftCollapsed.value;
  else if (action === "toggleRightPanel") rightCollapsed.value = !rightCollapsed.value;
  else if (action === "toggleMaximize") {
    if (showRight.value && !rightCollapsed.value) fileMaximized.value = !fileMaximized.value;
  }
  else if (action === "openThemes") showThemes.value = true;
  else if (action === "setAgentScope") {
    store.agentScope = detail.scope === "current" ? "current" : "all";
    // Re-sync even when scope is unchanged: clicking an already-checked item
    // makes Tauri auto-toggle it off, but the no-op store write skips the watch.
    invoke("update_agent_scope_menu", { scope: store.agentScope }).catch(() => {});
  }
  else if (action === "goToFile") window.dispatchEvent(new CustomEvent("open-file-search"));
  else if (action === "commandPalette") window.dispatchEvent(new CustomEvent("open-command-palette"));
  else if (action === "paletteAll") window.dispatchEvent(new CustomEvent("open-command-palette-all"));
  else if (action === "nextTab") cycleTab(1);
  else if (action === "prevTab") cycleTab(-1);
  else if (action === "splitRight") splitActivePane("h");
  else if (action === "splitDown") splitActivePane("v");
  else if (action === "newFile") newFile();
  else if (action === "closeTab") closeActiveTab();
  else if (action === "reopenClosedTab") filePanelTabs.reopenLastClosed();
  else if (action === "focusExplorer") focusFilePanel("explorer");
  else if (action === "focusSourceControl") focusFilePanel("sc");
  else if (action === "focusNotes") focusFilePanel("notes");
  else if (action === "focusTerminal") focusTerminal();
  else if (action === "checkForUpdates") window.dispatchEvent(new CustomEvent("check-for-updates"));
  else if (action === "undo" || action === "redo") {
    window.dispatchEvent(new CustomEvent("editor-action", { detail: action }));
  }
  else if (action === "selectAll") {
    // ⌘A is a custom menu action (Cocoa selectAll: doesn't reach Monaco).
    // Dispatch by focus — order matters: Monaco/xterm focus lives in a hidden
    // textarea, so check their containers before the generic input fallback.
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest(".monaco-editor")) {
      window.dispatchEvent(new CustomEvent("editor-action", { detail: "selectAll" }));
    } else if (el?.closest(".xterm")) {
      window.dispatchEvent(new CustomEvent("terminal-action", { detail: "selectAll" }));
    } else if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      (el as HTMLInputElement).select();
    } else {
      const preview = el?.closest(".md-preview");
      if (preview) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(preview);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }
}

function handleTabUpdated(e: Event) {
  const payload = (e as CustomEvent).detail;
  if (payload?.tabId) store.applyTabUpdate(payload);
}

function handleTabTitle(e: Event) {
  const payload = (e as CustomEvent).detail;
  if (payload?.tabId) store.applyTabTitle(payload);
}

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "r") e.preventDefault();
  // ⌘⌃⇧F — hidden FPS meter toggle (debug; deliberately not in the registry).
  if (e.metaKey && e.ctrlKey && e.shiftKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    toggleFpsMeter();
    return;
  }
  // ⌘⌃⇧N — hidden test notification (debug; not in the registry). Fires after a
  // 3s delay so you can defocus the window and confirm the OS notification path.
  if (e.metaKey && e.ctrlKey && e.shiftKey && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    setTimeout(() => { invoke("notify_test").catch(() => {}); }, 3000);
    return;
  }
  // Split the focused terminal pane. Only when a terminal owns focus, so Monaco's
  // ⌘D (add-selection-to-next-match) is untouched. Bindings are Cmd-only.
  if (shortcuts.matches("split-pane-h", e) || shortcuts.matches("split-pane-v", e)) {
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest(".xterm") || el?.closest("[data-terminal-drop]")) {
      e.preventDefault();
      splitActivePane(shortcuts.matches("split-pane-v", e) ? "v" : "h");
      return;
    }
  }
  // ⌘1–9: jump to terminal tab N. Parametric range — match logic stays hardcoded
  // (rebinding jump-to-tab is not wired in v1; the registry entry is display-only).
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
    if (selectTabByIndex(Number(e.key))) e.preventDefault();
    return;
  }
  // ⌘P/⌘K leak Ctrl into the terminal (Ctrl+P is readline/OpenCode); bail when a
  // terminal owns focus so it keeps Ctrl.
  const inTerminal = (() => {
    const el = document.activeElement as HTMLElement | null;
    return !!(el?.closest(".xterm") || el?.closest("[data-terminal-drop]"));
  })();
  // Run action (⌘⇧P) — checked before go-to-file so shift wins.
  if (!(e.ctrlKey && inTerminal) && shortcuts.matches("run-action", e)) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("open-command-palette"));
    return;
  }
  // Go to file (⌘P).
  if (!(e.ctrlKey && inTerminal) && shortcuts.matches("go-to-file", e)) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("open-file-search"));
    return;
  }
  // Command palette (⌘K) — unified files + actions.
  if (!(e.ctrlKey && inTerminal) && shortcuts.matches("command-palette", e)) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("open-command-palette-all"));
    return;
  }
  // Keyboard shortcuts cheatsheet (⌘⇧/).
  if (shortcuts.matches("shortcuts-help", e)) {
    e.preventDefault();
    showShortcuts.value = !showShortcuts.value;
    return;
  }
}

let unlistenNotification: (() => void) | null = null;
let unlistenSettings: (() => void) | null = null;
let unlistenPlaySound: (() => void) | null = null;
// Reused across notifications; main sends the resolved wav path (dev vs packaged).
let notifAudio: HTMLAudioElement | null = null;

// Keep View > Agents scope checkmarks in sync with the store (driven by both
// the menu items and the sidebar toggle).
watch(
  () => store.agentScope,
  (scope) => { invoke("update_agent_scope_menu", { scope }).catch(() => {}); },
  { immediate: true },
);

// Open external links in default browser
function handleLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("http://") || href.startsWith("https://")) {
    e.preventDefault();
    openExternal(href);
  }
}

function handleBeforeUnload() {
  window.dispatchEvent(new CustomEvent("shadow:flush"));
}

function handleShowBttf() {
  showBttf.value = true;
}

onMounted(async () => {
  initDismissObserver();
  initMainAreaObserver();
  document.addEventListener("click", handleLinkClick, true);
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("open-file-tab", handleOpenFileTab);
  window.addEventListener("open-file-search", handleOpenFileSearch);
  window.addEventListener("open-command-palette", handleOpenCommandPalette);
  window.addEventListener("open-command-palette-all", handleOpenPaletteAll);
  window.addEventListener("menu-action", handleMenuAction);
  window.addEventListener("open-branch-picker", openBranchPicker);
  window.addEventListener("keydown", handleGlobalKeydown, true);
  window.addEventListener("tab-updated", handleTabUpdated as EventListener);
  window.addEventListener("tab-title", handleTabTitle as EventListener);

  // Voice dictation: subscribe to speech events / hotkey, and push the current
  // hotkey config to the main process.
  dictation.wire();
  void dictation.syncHotkeyConfig();
  wireAgentNotifications();

  // Keyboard shortcut registry: load once, then update live on changes.
  void shortcuts.load();
  shortcuts.listenForChanges();

  // Warm Pierre/Shiki highlighter so first diff open is instant. Bulk of the
  // cost (oniguruma WASM, worker spawn, injection grammars) is theme-agnostic;
  // theme switches are reapplied via workerManager.setRenderOptions later.
  const idle = (window as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined;
  const warm = () => {
    void useDiffHighlighter().catch((e) =>
      console.warn("[App] diff highlighter preload failed", e),
    );
  };
  if (idle) idle(warm, { timeout: 2000 });
  else setTimeout(warm, 0);
  window.addEventListener("show-bttf", handleShowBttf);
  // menu-action Tauri events are bridged to the window in useRpc.initRpc.
  unlistenSettings = await listen<{ action: string }>("settings-action", (event) => {
    if (event.payload.action === "ui") showSettings.value = true;
    else if (event.payload.action === "open") openSettings();
    else if (event.payload.action === "themes") showThemes.value = true;
    else if (event.payload.action === "command-palette")
      window.dispatchEvent(new CustomEvent("open-command-palette"));
  });
  // Click on a native notification → focus the tab that fired it.
  unlistenNotification = await listen<{ tabId: string }>("focus-tab", (event) => {
    const tabId = event.payload?.tabId;
    if (!tabId) return;
    for (const [dirId, tabs] of Object.entries(store.terminalTabsByDirectory)) {
      if (!tabs.some((t) => t.id === tabId)) continue;
      if (store.selectedDirectoryId !== dirId) {
        const dir = store.directories.find((d) => d.id === dirId);
        if (dir) store.selectDirectory(dir);
      }
      store.setActiveTab(dirId, tabId);
      break;
    }
  });
  // Custom notification sound — main fires this alongside a silent OS
  // notification. Played via Chromium so it's cross-platform.
  unlistenPlaySound = await listen<{ path: string }>("play-notification-sound", (event) => {
    const path = event.payload?.path;
    if (!path) return;
    const src = convertFileSrc(path);
    if (!notifAudio || notifAudio.src !== src) notifAudio = new Audio(src);
    notifAudio.currentTime = 0;
    notifAudio.play().catch((e) => console.warn("[App] notification sound failed", e));
  });
  const rpc = useRpc();
  const sizesAtFireTime = { ...panelSizes.value };
  const leftCollapsedAtFireTime = leftCollapsed.value;
  const rightCollapsedAtFireTime = rightCollapsed.value;
  void Promise.all([
    rpc.request.getAppState({ key: "panel_left_px" }),
    rpc.request.getAppState({ key: "panel_right_px" }),
    rpc.request.getAppState({ key: "sidebar_left_collapsed" }),
    rpc.request.getAppState({ key: "sidebar_right_collapsed" }),
  ]).then(([leftStr, rightStr, leftCollapseStr, rightCollapseStr]) => {
    const next = { ...panelSizes.value };
    let changed = false;
    if (leftStr !== null) {
      const n = parseFloat(leftStr);
      if (Number.isFinite(n) && n !== next.left && next.left === sizesAtFireTime.left) {
        next.left = n;
        changed = true;
      }
    }
    if (rightStr !== null) {
      const n = parseFloat(rightStr);
      if (Number.isFinite(n) && n !== next.right && next.right === sizesAtFireTime.right) {
        next.right = n;
        changed = true;
      }
    }
    if (changed) {
      next.left = clamp(next.left, LEFT_PANEL_MIN_PX, LEFT_PANEL_MAX_PX);
      next.right = clamp(next.right, RIGHT_PANEL_MIN_PX, RIGHT_PANEL_MAX_PX);
      panelSizes.value = next;
      nextTick(() => {
        leftPanelRef.value?.resize(next.left);
        rightPanelRef.value?.resize(next.right);
      });
    }
    const dbLeftCollapsed = leftCollapseStr === "true";
    if (
      dbLeftCollapsed !== leftCollapsed.value &&
      leftCollapsed.value === leftCollapsedAtFireTime
    ) {
      leftCollapsed.value = dbLeftCollapsed;
    }
    // Null-guard: absent key means never-set, so keep the collapsed-by-default
    // (parsing absent as "false" would force the panel open on first run).
    if (rightCollapseStr !== null) {
      const dbRightCollapsed = rightCollapseStr === "true";
      if (
        dbRightCollapsed !== rightCollapsed.value &&
        rightCollapsed.value === rightCollapsedAtFireTime
      ) {
        rightCollapsed.value = dbRightCollapsed;
      }
    }
  }).catch((e) => console.warn("[App] panel state reconcile failed", e));
});
onUnmounted(() => {
  document.removeEventListener("click", handleLinkClick, true);
  window.removeEventListener("beforeunload", handleBeforeUnload);
  window.removeEventListener("open-file-tab", handleOpenFileTab);
  window.removeEventListener("open-file-search", handleOpenFileSearch);
  window.removeEventListener("open-command-palette", handleOpenCommandPalette);
  window.removeEventListener("open-command-palette-all", handleOpenPaletteAll);
  window.removeEventListener("menu-action", handleMenuAction);
  window.removeEventListener("open-branch-picker", openBranchPicker);
  window.removeEventListener("keydown", handleGlobalKeydown, true);
  window.removeEventListener("tab-updated", handleTabUpdated as EventListener);
  unwireAgentNotifications();
  window.removeEventListener("tab-title", handleTabTitle as EventListener);
  window.removeEventListener("show-bttf", handleShowBttf);
  for (const timer of Object.values(panelSaveTimers)) clearTimeout(timer);
  if (collapseTimer) clearTimeout(collapseTimer);
  unlistenNotification?.();
  unlistenSettings?.();
  unlistenPlaySound?.();
  notifAudio = null;
  dismissObserver?.disconnect();
  mainAreaObserver?.disconnect();
});
</script>

<template>
  <div class="relative flex h-screen bg-sidebar">
    <!-- Persistent top-left controls: the same toggle + search nodes stay mounted
         whether the left panel is open or collapsed (anchored after the macOS
         traffic lights). `.drag-region` here is JS-only (native drag is disabled
         app-wide, see style.css), so `useWindowDrag` drags the strip while
         excluding the buttons — buttons stay clickable, empty strip drags. -->
    <div
      v-if="!showSettings && !onboarding"
      class="drag-region absolute top-0 left-0 z-50 h-11.5 flex items-center gap-0.5 pl-[78px]"
    >
      <TooltipProvider :delay-duration="300">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground"
              tabindex="0"
              @click="leftCollapsed = !leftCollapsed"
            >
              <PanelLeftFilled class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" class="flex items-center gap-2">
            <span>{{ leftCollapsed ? "Show Sidebar" : "Hide Sidebar" }}</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-left-panel')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground hover:text-foreground"
              tabindex="0"
              @click="handleOpenFileSearch"
            >
              <Search class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" class="flex items-center gap-2">
            <span>Go to File</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('go-to-file')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
    <!-- No workspaces: full-screen onboarding, no sidebar/header chrome. -->
    <div
      v-if="onboarding"
      class="drag-region flex-1 flex items-center justify-center bg-sidebar"
    >
      <WelcomeHero :mode="onboarding" />
    </div>
    <!-- Left sidebar: full height -->
    <ResizablePanelGroup
      v-else
      :key="`left-${showRight}`"
      direction="horizontal"
      class="flex-1 overflow-hidden relative"
      @layout="onPanelLayout"
    >
      <template v-if="!leftCollapsed">
        <ResizablePanel
          ref="leftPanelRef"
          id="left-sidebar"
          :order="1"
          :default-size="panelSizes.left"
          :min-size="LEFT_PANEL_MIN_PX"
          :max-size="LEFT_PANEL_MAX_PX"
          size-unit="px"
          class="bg-sidebar"
        >
          <div class="h-full flex flex-col">
            <!-- Traffic light spacer + drag region + resource monitor.
                 (Left toggle + search live in the persistent overlay above.) -->
            <div
              class="drag-region h-11.5 shrink-0 flex items-center justify-end pr-1"
            >
              <ResourceMonitor v-if="!showSettings" class="relative z-10" />
            </div>
            <SettingsSidebar
              v-if="showSettings"
              class="flex-1 min-h-0"
              @close="showSettings = false"
              @flux-capacitor="showBttf = true"
            />
            <Sidebar
              v-else
              class="flex-1 min-h-0"
              @open-settings="showSettings = true"
              @open-shortcuts="showShortcuts = true"
            />
          </div>
        </ResizablePanel>
        <ResizableHandle :class="handleClass" @dragging="setSplitterDragging" />
      </template>

      <!-- Right section: header + center + right sidebar -->
      <ResizablePanel id="main-area" :order="2" :min-size="30">
        <div ref="mainAreaEl" class="h-full flex flex-col">
          <header
            v-if="false && !showSettings"
            class="relative flex items-center justify-between border-b h-11.5 border-border pr-1 py-2 select-none text-muted-foreground shrink-0"
            :class="leftCollapsed ? 'pl-20' : 'pl-4'"
          >
            <div
              class="drag-region absolute inset-0"
            />
            <div class="relative z-10 flex items-center gap-0.5 min-w-0">
              <Button
                v-if="leftCollapsed"
                size="icon-xs"
                variant="ghost"
                class="shrink-0 mr-1"
                tabindex="0"
                @click="leftCollapsed = false"
              >
                <PanelLeft class="size-3.5" />
              </Button>
              <div
                v-if="store.selectedDirectory"
                class="flex items-center gap-1.5 text-xs min-w-0"
              >
                <Button :as="'div'" variant="ghost" size="xs" class="font-normal text-foreground/80 min-w-0 px-0 has-[>svg]:px-0 hover:bg-transparent hover:text-foreground/80">
                  <img
                    v-if="displayedDirectory && projectIcons[displayedDirectory!.id]"
                    :src="projectIcons[displayedDirectory!.id]"
                    class="size-4 object-contain shrink-0"
                  />
                  <FolderOpen
                    v-else
                    class="size-3.5 shrink-0"
                  />
                  <span class="whitespace-nowrap max-w-[20rem] truncate">{{ displayedDirectory?.name }}</span>
                </Button>
                <HeaderBranchPill />
              </div>
            </div>
            <div class="relative z-10 flex items-center pr-1">
              <OpenInIdeButton
                v-if="store.selectedDirectory"
                :directory-path="store.selectedDirectory!.path"
              />
            </div>
          </header>

          <SettingsScreen
            v-show="showSettings"
            class="flex-1 overflow-hidden"
            @close="showSettings = false"
            @flux-capacitor="showBttf = true"
          />
          <ResizablePanelGroup
            v-show="!showSettings"
            :key="`inner-${showRight}`"
            direction="horizontal"
            class="inner-resize-group flex-1 overflow-hidden"
            :class="{ 'is-file-maximized': fileMaximized }"
            @layout="onInnerLayout"
          >
            <ResizablePanel id="center" :order="1" :min-size="centerMinPct" class="maximize-center">
              <TabsCenter class="h-full" />
            </ResizablePanel>

            <template v-if="showRight && !rightCollapsed">
              <ResizableHandle :class="[handleClass, 'maximize-handle']" @dragging="setSplitterDragging" />
              <ResizablePanel
                ref="rightPanelRef"
                id="right-sidebar"
                :order="2"
                :default-size="panelSizes.right"
                :min-size="RIGHT_PANEL_MIN_PX"
                size-unit="px"
                class="maximize-right bg-[var(--editor-bg)]"
              >
                <RightPanel
                  class="h-full"
                  :maximized="fileMaximized"
                  @toggle-right="rightCollapsed = !rightCollapsed"
                  @toggle-maximize="fileMaximized = !fileMaximized"
                />
              </ResizablePanel>
            </template>
          </ResizablePanelGroup>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
    <ThemeSelector v-model:open="showThemes" />
    <CommandPalette
      v-model:open="showFileSearch"
      :initial-mode="fileSearchMode"
      @open-file="openFileFromPalette"
    />
    <BranchPickerDialog
      v-if="branchPickerPath"
      :open="branchPickerOpen"
      :working-path="branchPickerPath"
      :current-branch="branchPickerBranch"
      @update:open="(v: boolean) => (branchPickerOpen = v)"
    />
    <KeyboardShortcutsModal
      :open="showShortcuts"
      @update:open="(v: boolean) => (showShortcuts = v)"
    />
    <Transition name="chord">
      <div
        v-if="chordHint"
        class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-md bg-popover border border-border px-3 py-1.5 text-xs text-popover-foreground shadow-md"
      >
        {{ chordHint }}
      </div>
    </Transition>
    <Toaster
      position="bottom-right"
      :duration="3000"
      theme="dark"
    />
    <BttfEasterEgg
      v-if="showBttf"
      @done="showBttf = false"
    />
    <FpsMeter />
    <DictationOverlay />
    <DaemonRestartOverlay />
  </div>
</template>

<style scoped>
/* Maximize: override reka-ui's inline flex so the file panel fills the inner
   area and the terminal/agent center collapses out of view. Pure CSS override
   keeps both panels mounted (terminals stay warm) and leaves the persisted
   sizes untouched, so un-maximizing restores the exact prior layout. */
.inner-resize-group.is-file-maximized :deep(.maximize-center) {
  flex: 0 0 0 !important;
  overflow: hidden !important;
  pointer-events: none !important;
}
.inner-resize-group.is-file-maximized :deep(.maximize-handle) {
  display: none !important;
}
.inner-resize-group.is-file-maximized :deep(.maximize-right) {
  flex: 1 1 0% !important;
  max-width: 100% !important;
}

.chord-enter-active,
.chord-leave-active {
  transition: opacity 0.15s ease;
}

.chord-enter-from,
.chord-leave-to {
  opacity: 0;
}
</style>
