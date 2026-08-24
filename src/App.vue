<script setup lang="ts">
import { defineAsyncComponent, provide, ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { listen, openExternal, invoke, convertFileSrc } from "./platform";
import { useProjectIcons } from "./composables/useProjectIcons";
import { useWorkspaceStore } from "./stores/workspace";
import { useRpc } from "./composables/useRpc";
import RightPanel from "./components/RightPanel.vue";
import ThemeSelector from "./components/ThemeSelector.vue";
import { Toaster } from "./components/ui/sonner";
import {
  PanelLeft,
  PanelRight,
  PanelBottom,
  FolderOpen,
  Check,
  Search,
  Maximize2,
  Minimize2,
} from "@lucide/vue";
import PanelLeftFilled from "./components/icons/PanelLeftFilled.vue";
import PanelRightFilled from "./components/icons/PanelRightFilled.vue";
import PanelBottomFilled from "./components/icons/PanelBottomFilled.vue";
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
import {
  usePanelAnimation,
  trackSplitterDrag,
  isSplitterDragging,
  panelsAnimating,
} from "./composables/usePanelAnimation";
import { setRightPanelSliding } from "@/lib/panelAnimationState";
import { useChordHint } from "./composables/useChordHint";
import { useFpsMeter } from "./composables/useFpsMeter";
import FpsMeter from "./components/FpsMeter.vue";
import { useFilePanelTabs } from "./composables/useFilePanelTabs";
import { useDiffHighlighter } from "./composables/useDiffHighlighter";
import {
  readCachedPanelState,
  writeCachedPanelPx,
  writeCachedRightPct,
  writeCachedSidebarCollapsed,
} from "@/lib/bootstrapCache";
import { PANEL_SIZES } from "@/lib/panelSizes";

import SettingsScreen from "./components/SettingsScreen.vue";
import SettingsSidebar from "./components/SettingsSidebar.vue";
import OpenInIdeButton from "@/components/OpenInIdeButton.vue";
import HeaderBranchPill from "@/components/HeaderBranchPill.vue";
import BranchPickerDialog from "@/components/BranchPickerDialog.vue";
import TabsCenter from "@/components/main/TabsCenter.vue";
import BottomPanel from "@/components/main/BottomPanel.vue";
import WelcomeHero from "@/components/main/WelcomeHero.vue";
import Sidebar from "@/components/sidebar/Sidebar.vue";
import NewSessionButton from "@/components/sidebar/NewSessionButton.vue";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import { flushTerminalLayouts } from "@/composables/useTerminal";
import { useWindowDrag } from "@/composables/useWindowDrag";
import DictationOverlay from "@/components/DictationOverlay.vue";
import DaemonRestartOverlay from "@/components/DaemonRestartOverlay.vue";
import { useDictation } from "@/composables/useDictation";
import { useShortcuts } from "@/composables/useShortcuts";
import { wireAgentNotifications, unwireAgentNotifications } from "@/composables/useAgentNotifications";
import { useSettingsScreen } from "@/composables/useSettingsScreen";
import { useAppUpdates } from "@/composables/useAppUpdates";
import { useDaemonStaleness } from "@/composables/useDaemonStaleness";
import { disposeAgentInventory } from "@/composables/useAgentInventory";
import { useAgentUpdateAdvisory } from "@/composables/useAgentUpdateAdvisory";

const dictation = useDictation();
const shortcuts = useShortcuts();
useAppUpdates();
useDaemonStaleness();
useAgentUpdateAdvisory();
const BttfEasterEgg = defineAsyncComponent(() => import("./components/BttfEasterEgg.vue"));

// Manual window-drag fallback for tab bars clipped by reka-ui resizable panels,
// where native -webkit-app-region: drag is dropped.
useWindowDrag();

const store = useWorkspaceStore();
watch(
  () => store.selectedDirectoryId,
  (dirId) => {
    if (dirId) {
      void store.loadTabsForDirectory(dirId).catch((error) => {
        console.error("[App] scope load failed:", error);
      });
    }
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

function relayoutAfterPanelChange(): void {
  requestAnimationFrame(() => flushTerminalLayouts());
  // Monaco's automaticLayout can miss these abrupt flex changes under WKWebView
  // (blank editor) — force an explicit remeasure once the layout settles.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("relayout-editors")),
    ),
  );
}
// fileMaximized is still a one-shot class flip, so it flushes immediately.
// The collapse toggles are animated (below) and flush when the slide settles —
// GridTerminal's own trailing resize debounce already coalesces the frames in
// between into a single PTY resize at the final size.
watch(fileMaximized, () => relayoutAfterPanelChange());

// Animated collapse: `leftAnim`/`rightAnim` are true only while a toggle is in
// flight, which is what gates both the CSS transition and layout persistence.
// Suppressed until the persisted collapse state has been reconciled from the DB
// so a slow first load doesn't slide the panels around at startup.
const panelAnimReady = ref(false);
const leftAnim = usePanelAnimation(relayoutAfterPanelChange);
const rightAnim = usePanelAnimation(relayoutAfterPanelChange);
// Content stays mounted through a close so the panel isn't blank while it
// slides out; it unmounts (releasing its watchers/terminals) once settled.
const leftContentVisible = computed(() => !leftCollapsed.value || leftAnim.animating.value);
const rightContentVisible = computed(() => !rightCollapsed.value || rightAnim.animating.value);

function applyPanelCollapse(
  panel: { collapse: () => void; expand: () => void; resize: (n: number) => void } | null,
  collapsed: boolean,
  expandedSize: number,
): void {
  if (!panel) return;
  if (collapsed) {
    panel.collapse();
    return;
  }
  // reka's expand() restores its own remembered pre-collapse size, which it
  // doesn't have on a fresh mount (it would fall back to min-size and lose the
  // user's persisted width). Expand, then land the exact size ourselves.
  panel.expand();
  panel.resize(expandedSize);
}

const canAnimatePanels = () => panelAnimReady.value && !isSplitterDragging();
// Published so the pane header can clear its trailing actions for this slide
// specifically — they sit still through a left or bottom one.
watch(rightAnim.animating, (active) => setRightPanelSliding(active));
// Crossfades with the pane's split menu, which shares this exact slot.
//
// Opening: shows from the first frame, growing in as the split menu vanishes.
// Closing: HOLDS through the slide and only starts leaving once it lands —
// that is the moment the split menu has finished travelling into the slot, so
// the two overlap and genuinely cross-dissolve instead of taking turns.
const showStripMaximize = computed(
  () => !rightCollapsed.value || rightAnim.animating.value,
);

// When the change isn't animated (startup reconcile, drag-collapse) there's no
// settle callback to hang the relayout off, so flush it here instead.
watch(leftCollapsed, (collapsed) => {
  if (canAnimatePanels()) leftAnim.begin();
  else relayoutAfterPanelChange();
  applyPanelCollapse(leftPanelRef.value, collapsed, panelSizes.value.left);
});
watch(rightCollapsed, (collapsed) => {
  if (canAnimatePanels()) rightAnim.begin();
  else relayoutAfterPanelChange();
  applyPanelCollapse(rightPanelRef.value, collapsed, panelSizes.value.right);
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
const RIGHT_PANEL_MIN_PX = PANEL_SIZES.right.minPx;
const RIGHT_PANEL_DEFAULT_PCT = PANEL_SIZES.right.defaultPct;
const CENTER_PANEL_MIN_PX = PANEL_SIZES.center.min;

// Center + right form one % group: they split the space between them, so the
// right panel keeps its share of the group on window resize. Both px floors are
// expressed as a % of the live inner-group width.
const mainAreaEl = ref<HTMLElement | null>(null);
const mainAreaWidth = ref(0);
const pxToPct = (px: number, fallback: number) => {
  const w = mainAreaWidth.value;
  if (!w) return fallback;
  return Math.max(5, Math.min(90, (px / w) * 100));
};
// Width the main area will have once the current slide lands. It only sweeps
// for a LEFT slide (the sidebar's width leaving or arriving); snapshotting at
// the toggle works because the measurement is still the pre-slide one then.
const projectedMainAreaWidth = ref(0);
watch(leftCollapsed, (collapsed) => {
  projectedMainAreaWidth.value = Math.max(
    0,
    mainAreaWidth.value + (collapsed ? panelSizes.value.left : -panelSizes.value.left),
  );
});

// The right panel is %-sized, so both its slide-time pin and the width its
// inner sidebars judge themselves against need a px value — and it has to be
// the SETTLED one, or they reconfigure after the slide instead of during it.
const rightPinnedPx = computed(() => {
  const base =
    leftAnim.animating.value && projectedMainAreaWidth.value
      ? projectedMainAreaWidth.value
      : mainAreaWidth.value;
  return Math.round((panelSizes.value.right / 100) * base);
});
// Anchored to the panel's RIGHT edge, which is the edge that stays put — the
// left edge is the one sweeping. Pinning to the left edge (a plain width) made
// the whole file panel translate across the screen instead of being revealed.
const rightSlideStyle = computed(() =>
  rightAnim.animating.value && rightPinnedPx.value
    ? {
        position: "absolute" as const,
        top: "0",
        right: "0",
        height: "100%",
        width: `${rightPinnedPx.value}px`,
      }
    : undefined,
);
const centerMinPct = computed(() => pxToPct(CENTER_PANEL_MIN_PX, 20));
const rightMinPct = computed(() => pxToPct(RIGHT_PANEL_MIN_PX, 20));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const legacyPanelPx = (percent: number | null, fallback: number, min: number, max: number) =>
  clamp(percent == null ? fallback : (window.innerWidth * percent) / 100, min, max);

// Left sidebar is px-sized so it keeps the user's width when the window changes.
// Right is a % of the center+right group (`right` below is a percentage).
const panelSizes = ref({
  left: clamp(
    cachedPanels.leftPx ?? legacyPanelPx(cachedPanels.left, PANEL_SIZES.left.default, LEFT_PANEL_MIN_PX, LEFT_PANEL_MAX_PX),
    LEFT_PANEL_MIN_PX,
    LEFT_PANEL_MAX_PX,
  ),
  right: clamp(cachedPanels.rightPct ?? RIGHT_PANEL_DEFAULT_PCT, 5, 95),
});
const filePanelTabs = useFilePanelTabs(() => store.activeRoot);
const panelSaveTimers: Partial<Record<"left" | "right", ReturnType<typeof setTimeout>>> = {};

// Outer layout: left sidebar vs rest
function onPanelLayout(sizes: number[]) {
  // Mid-slide sizes are transient — persisting one would stomp the stored width.
  if (leftAnim.animating.value) return;
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

// Inner layout: center vs right panel — % of the group.
function onInnerLayout(sizes: number[]) {
  if (rightAnim.animating.value) return;
  const rightMounted = showRight.value && !rightCollapsed.value;
  const rightIdx = rightMounted ? sizes.length - 1 : -1;
  const right = rightIdx >= 0 && sizes[rightIdx] > 0 ? sizes[rightIdx] : panelSizes.value.right;
  panelSizes.value = { ...panelSizes.value, right };
  if (rightIdx >= 0 && sizes[rightIdx] > 0) writeCachedRightPct(right);
  if (panelSaveTimers.right) clearTimeout(panelSaveTimers.right);
  panelSaveTimers.right = setTimeout(() => {
    if (rightIdx >= 0 && sizes[rightIdx] > 0)
      useRpc().request.setAppState({ key: "panel_right_pct", value: right.toFixed(2) });
  }, 500);
}

const bottomPanelRef = ref<InstanceType<typeof BottomPanel> | null>(null);
function onBottomLayout(sizes: number[]) {
  bottomPanelRef.value?.onLayout(sizes);
}

const {
  icons: projectIcons,
  transparentIcons: transparentProjectIcons,
  loadIcon: loadProjectIcon,
} = useProjectIcons();

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

function newTerminal() {
  const dirId = store.selectedDirectoryId;
  if (store.activeSurface === "bottom" && dirId) {
    void store.createBottomTerminal(dirId);
    return;
  }
  store.openSessionPicker();
}

// Drives the filled icon on the bottom-panel toggle: open == has terminals and
// not collapsed, matching what the panel itself renders.
const bottomPanelOpen = computed(() => {
  const dirId = store.selectedDirectoryId;
  const state = dirId ? store.bottomPanelFor(dirId) : null;
  return !!state?.tabs.length && !state.collapsed;
});

// App.vue owns the vertical panel group, so it also owns the bottom panel's
// animation gate and passes it down (BottomPanel renders into this group).
const bottomAnim = usePanelAnimation(relayoutAfterPanelChange);
// `bottomPanelOpen` is per-scope, so it also flips when the selected workspace
// changes — switching sessions was raising a slide (and with it the center's
// blur cover) for something the user never toggled. Only a change WITHIN a
// scope is a toggle.
let lastBottomScopeId: string | null = store.selectedDirectoryId ?? null;
watch(bottomPanelOpen, () => {
  const scopeId = store.selectedDirectoryId ?? null;
  const scopeChanged = scopeId !== lastBottomScopeId;
  lastBottomScopeId = scopeId;
  if (scopeChanged) return;
  if (canAnimatePanels()) bottomAnim.begin();
});

// ⌃` — show/hide the bottom terminal panel, creating the first terminal if the
// scope has none.
function toggleBottomPanel() {
  const dirId = store.selectedDirectoryId;
  if (!dirId) return;
  const state = store.bottomPanelFor(dirId);
  if (!state?.tabs.length) {
    void store.createBottomTerminal(dirId);
    return;
  }
  store.setBottomPanelCollapsed(dirId, !state.collapsed);
}

async function newWorktree() {
  const dir = store.selectedDirectory;
  if (!dir) return;
  // Worktrees nest under root dirs — if a worktree is selected, use its parent.
  const parentId = dir.parentDirectoryId ?? dir.id;
  try {
    const wt = await store.createWorktree(parentId, "");
    store.selectDirectory(wt);
    store.openSessionPicker(wt.id);
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
  store.selectSession(next.id);
}

// Activate terminal tab N (1-based) in the selected directory. Center only —
// bottom terminals aren't in the sidebar, so counting them would desync ⌘1–9
// from what the user is numbering off.
function selectTabByIndex(n: number) {
  const dirId = store.selectedDirectoryId;
  if (!dirId) return false;
  const tab = store.centerSessions(dirId)[n - 1];
  if (!tab) return false;
  store.selectSession(tab.id);
  return true;
}

// ⌘W — close the focused tab: right-panel tab if focus is in the file panel, the
// focused bottom terminal if the bottom panel owns focus, else the active
// terminal tab. Each owner applies its own close confirmation.
function closeActiveTab() {
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest("[data-file-panel]")) {
    window.dispatchEvent(new CustomEvent("close-active-file-tab"));
  } else if (store.activeSurface === "bottom" && store.bottomFocusedSessionId) {
    window.dispatchEvent(new CustomEvent("close-active-bottom-pane"));
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

function focusSession() {
  fileMaximized.value = false;
  window.dispatchEvent(new CustomEvent("terminal-action", { detail: "focus" }));
}

// Split the focused terminal pane. 'h' = side-by-side, 'v' = stacked. The bottom
// panel is side-by-side only, so its pane headers stay one continuous bar.
function splitActivePane(direction: "h" | "v") {
  void store.splitActivePane(direction);
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
  else if (action === "goToFile") window.dispatchEvent(new CustomEvent("open-file-search"));
  else if (action === "commandPalette") window.dispatchEvent(new CustomEvent("open-command-palette"));
  else if (action === "paletteAll") window.dispatchEvent(new CustomEvent("open-command-palette-all"));
  else if (action === "nextTab") cycleTab(1);
  else if (action === "prevTab") cycleTab(-1);
  else if (action === "splitRight") splitActivePane("h");
  else if (action === "splitDown") splitActivePane("v");
  else if (action === "newFile") newFile();
  else if (action === "closeTab") closeActiveTab();
  else if (action === "killTerminalSession") window.dispatchEvent(new CustomEvent("kill-active-terminal-session"));
  else if (action === "reopenClosedTab") filePanelTabs.reopenLastClosed();
  else if (action === "focusExplorer") focusFilePanel("explorer");
  else if (action === "focusSourceControl") focusFilePanel("sc");
  else if (action === "focusNotes") focusFilePanel("notes");
  else if (action === "focusSession") focusSession();
  else if (action === "toggleBottomPanel") toggleBottomPanel();
  else if (action === "checkForUpdates") window.dispatchEvent(new CustomEvent("check-for-updates"));
  else if (action === "restartToUpdate") void invoke("updater_quit_and_install");
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

function handleTabExited(e: Event) {
  const detail = (e as CustomEvent<{ tabId: string }>).detail;
  if (detail?.tabId) store.markSessionExited(detail.tabId);
}

function handleSessionScopeChanged(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (detail?.tabId) store.applyScopeChange(detail);
}

function handleDirectoryAdded(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (detail?.directory) store.applyDirectoryAdded(detail.directory);
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
  // Drives the filled icon on the bottom-panel toggle: open == has terminals and
// not collapsed, matching what the panel itself renders.
const bottomPanelOpen = computed(() => {
  const dirId = store.selectedDirectoryId;
  const state = dirId ? store.bottomPanelFor(dirId) : null;
  return !!state?.tabs.length && !state.collapsed;
});

// ⌃` toggles the bottom panel. Capture phase on window, before GridTerminal's
  // element handler, so a focused terminal can never swallow it (stopPropagation
  // is what keeps the key off the PTY).
  if (shortcuts.matches("toggle-bottom-panel", e)) {
    e.preventDefault();
    e.stopPropagation();
    toggleBottomPanel();
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
  // Kill session (⌥⌘W) — explicit kill, distinct from ⌘W's remove-from-view. Only
  // when a terminal owns focus, same gate as the split-pane branch above.
  if (shortcuts.matches("kill-session", e)) {
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest(".xterm") || el?.closest("[data-terminal-drop]")) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("kill-active-terminal-session"));
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
  window.addEventListener("tab-exited", handleTabExited as EventListener);
  window.addEventListener("session-scope-changed", handleSessionScopeChanged as EventListener);
  window.addEventListener("directory-added", handleDirectoryAdded as EventListener);

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
      store.selectSession(tabId);
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
    rpc.request.getAppState({ key: "panel_right_pct" }),
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
      next.right = clamp(next.right, 5, 95);
      panelSizes.value = next;
      nextTick(() => {
        // Never resize a collapsed panel — that would silently reopen it.
        if (!leftCollapsed.value) leftPanelRef.value?.resize(next.left);
        if (!rightCollapsed.value) rightPanelRef.value?.resize(next.right);
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
  }).catch((e) => console.warn("[App] panel state reconcile failed", e))
    // Only animate toggles the user drives — not the startup reconcile, which
    // would otherwise slide the panels into place on every launch.
    .finally(() => nextTick(() => (panelAnimReady.value = true)));
});
onUnmounted(() => {
  disposeAgentInventory();
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
  window.removeEventListener("tab-exited", handleTabExited as EventListener);
  window.removeEventListener("session-scope-changed", handleSessionScopeChanged as EventListener);
  window.removeEventListener("directory-added", handleDirectoryAdded as EventListener);
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
  <div class="app-window-surface relative flex h-screen">
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
    <!-- Persistent top-right controls, mirroring the top-left strip: ONE set of
         nodes that stays mounted and stays put whether the right panel is open
         or collapsed. Previously these existed twice — once in FileTabBar's
         actions cell, once in TabsCenter's overlay — so toggling the panel
         swapped one instance for the other mid-slide.

         Right-anchored, so Maximize (which only applies while the file panel is
         up) grows/shrinks the strip on the LEFT and the two permanent toggles
         never move. When the panel is collapsed the pane's own split menu takes
         that vacated slot, which is what makes the two states read as a swap
         rather than a reflow. Whatever sits underneath reserves the width:
         `pr-[82px]` on the file tab bar, `reserveRightOverlay` on the pane. -->
    <div
      v-if="!showSettings && !onboarding && store.selectedDirectory"
      class="drag-region absolute top-0 right-0 z-50 h-11.5 flex items-center pr-1.5"
    >
      <TooltipProvider :delay-duration="300">
        <!-- Maximize shares its slot with the pane's split menu, which travels
             into it as the panel closes. So it collapses its width as it fades
             rather than unmounting: the slot is genuinely handed over, and the
             two never overlap because it only shows once the slide has landed. -->
        <span class="strip-maximize" :class="{ 'is-shown': showStripMaximize }">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                size="icon-xs"
                variant="ghost"
                :class="fileMaximized ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
                :tabindex="showStripMaximize ? 0 : -1"
                :aria-hidden="!showStripMaximize"
                @click="fileMaximized = !fileMaximized"
              >
                <Minimize2 v-if="fileMaximized" class="size-3.5" />
                <Maximize2 v-else class="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{{ fileMaximized ? "Restore Panel" : "Maximize Panel" }}</TooltipContent>
          </Tooltip>
        </span>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground hover:text-foreground"
              tabindex="0"
              :aria-label="bottomPanelOpen ? 'Hide Bottom Panel' : 'Show Bottom Panel'"
              @click="toggleBottomPanel"
            >
              <PanelBottomFilled v-if="bottomPanelOpen" class="size-3.5" />
              <PanelBottom v-else class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" class="flex items-center gap-2">
            <span>{{ bottomPanelOpen ? "Hide Bottom Panel" : "Show Bottom Panel" }}</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-bottom-panel')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              size="icon-xs"
              variant="ghost"
              class="ml-0.5 text-muted-foreground hover:text-foreground"
              tabindex="0"
              :aria-label="rightCollapsed ? 'Show Right Panel' : 'Hide Right Panel'"
              @click="rightCollapsed = !rightCollapsed"
            >
              <PanelRightFilled v-if="!rightCollapsed" class="size-3.5" />
              <PanelRight v-else class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" class="flex items-center gap-2">
            <span>{{ rightCollapsed ? "Show Panel" : "Hide Panel" }}</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-right-panel')" :key="i">{{ key }}</Kbd>
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
      :class="{ 'panel-anim': leftAnim.animating.value }"
      @layout="onPanelLayout"
    >
      <ResizablePanel
        ref="leftPanelRef"
        id="left-sidebar"
        :order="1"
        :default-size="leftCollapsed ? 0 : panelSizes.left"
        :min-size="LEFT_PANEL_MIN_PX"
        :max-size="LEFT_PANEL_MAX_PX"
        collapsible
        :collapsed-size="0"
        size-unit="px"
        class="bg-sidebar"
        @collapse="leftCollapsed = true"
        @expand="leftCollapsed = false"
      >
        <!-- Pinned to the expanded width while sliding so the sidebar's own
             layout doesn't reflow every frame — it slides under the clip. -->
        <div
          v-if="leftContentVisible"
          class="h-full flex flex-col"
          :style="leftAnim.animating.value ? { width: `${panelSizes.left}px` } : undefined"
        >
          <!-- Traffic light spacer + drag region + New Session.
               (Left toggle + search live in the persistent overlay above.) -->
          <div
            class="drag-region h-11.5 shrink-0 flex items-center justify-end pr-1"
          >
            <NewSessionButton
              v-if="!showSettings"
              class="relative z-10"
              @new-session="newTerminal"
            />
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
      <!-- Hidden (and undraggable) once collapsed, but kept through the slide
           so its divider travels with the panel edge. -->
      <ResizableHandle
        :class="[handleClass, !leftContentVisible && 'pointer-events-none opacity-0']"
        @dragging="trackSplitterDrag"
      />

      <!-- Right section: header + center + right sidebar -->
      <ResizablePanel id="main-area" :order="2" :min-size="30" class="bg-[var(--editor-bg)]">
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
                    :class="[
                      'size-4 shrink-0 object-contain',
                      transparentProjectIcons[displayedDirectory!.id] && 'p-0.5',
                    ]"
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
            direction="vertical"
            class="flex-1 overflow-hidden"
            :class="{ 'panel-anim': bottomAnim.animating.value }"
            @layout="onBottomLayout"
          >
            <ResizablePanel id="main-upper" :order="1" :min-size="20">
              <ResizablePanelGroup
                :key="`inner-${showRight}`"
                direction="horizontal"
                class="inner-resize-group overflow-hidden"
                :class="{
                  'is-file-maximized': fileMaximized,
                  'panel-anim': rightAnim.animating.value,
                }"
                @layout="onInnerLayout"
              >
                <ResizablePanel id="center" :order="1" :min-size="centerMinPct" class="maximize-center">
                  <TabsCenter class="h-full" />
                </ResizablePanel>

                <template v-if="showRight">
                  <ResizableHandle
                    :class="[handleClass, 'maximize-handle', !rightContentVisible && 'pointer-events-none opacity-0']"
                    @dragging="trackSplitterDrag"
                  />
                  <ResizablePanel
                    ref="rightPanelRef"
                    id="right-sidebar"
                    :order="2"
                    :default-size="rightCollapsed ? 0 : panelSizes.right"
                    :min-size="rightMinPct"
                    collapsible
                    :collapsed-size="0"
                    class="maximize-right relative bg-[var(--editor-bg)]"
                    @collapse="rightCollapsed = true"
                    @expand="rightCollapsed = false"
                  >
                    <RightPanel
                      v-if="rightContentVisible"
                      class="h-full"
                      :expected-width="rightPinnedPx || undefined"
                      :style="rightSlideStyle"
                    />
                  </ResizablePanel>
                </template>
              </ResizablePanelGroup>
            </ResizablePanel>
            <BottomPanel ref="bottomPanelRef" :animating="bottomAnim.animating.value" />
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
/* Panel open/close animation. reka-ui sizes every panel with an inline
   `flex-basis:0; flex-grow:<n>`, and grow is proportional to the group total —
   so the transition must cover ALL panels in the group, not just the one being
   collapsed, or the widths won't interpolate cleanly.

   `.panel-anim` is present only while a toggle is in flight (usePanelAnimation),
   which is what keeps splitter dragging frame-exact: a drag never sets it. */
.panel-anim > :deep([data-slot="resizable-panel"]) {
  transition: flex-grow 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
.panel-anim > :deep([data-slot="resizable-handle"]) {
  transition: opacity 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
@media (prefers-reduced-motion: reduce) {
  .panel-anim > :deep([data-slot="resizable-panel"]),
  .panel-anim > :deep([data-slot="resizable-handle"]) {
    transition: none;
  }
}

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

/* Width collapses with the fade so the slot is released to the pane's split
   menu; the strip is right-anchored, so the two toggles never move. Exact
   widths matter — the reserves downstream are px-precise: 82px open
   (FileTabBar `pr-[82px]`), 56px collapsed (pane header `pr-14`). */
.strip-maximize {
  display: inline-flex;
  align-items: center;
  overflow: hidden;
  width: 0;
  margin-right: 0;
  opacity: 0;
  transform-origin: right center;
  transform: scale(0.85);
  /* Width steps rather than eases: animating it in a right-anchored strip makes
     the icon look like it slides in from the edge instead of fading in place.
     On the way out it holds until the fade has finished, then collapses,
     releasing the slot to the pane's split menu. */
  transition:
    opacity 150ms ease-out,
    transform 150ms cubic-bezier(0.32, 0.72, 0, 1),
    width 0s linear 150ms,
    margin-right 0s linear 150ms;
}
.strip-maximize.is-shown {
  width: 1.5rem;
  margin-right: 0.125rem;
  opacity: 1;
  transform: scale(1);
  /* Claim the slot and fade straight away — no wait on the slide, the strip
     doesn't move, so there's nothing to catch this against. */
  transition:
    opacity 150ms ease-out,
    transform 150ms cubic-bezier(0.32, 0.72, 0, 1),
    width 0s,
    margin-right 0s;
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
