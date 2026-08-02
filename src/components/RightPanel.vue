<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent, provide } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useFilePanelTabs, type ScSelection, type CommitsSelection } from "@/composables/useFilePanelTabs";
import { useRpc } from "@/composables/useRpc";
import FileTabBar from "./FileTabBar.vue";
import SearchPreview from "./SearchPreview.vue";
import SearchPreviewHeader from "./SearchPreviewHeader.vue";
// Async so Milkdown/ProseMirror only loads when the notes tab is opened.
const NotesPanel = defineAsyncComponent(() => import("./NotesPanel.vue"));
const SearchPanel = defineAsyncComponent(() => import("./SearchPanel.vue"));
// Async so WKWebView plumbing only loads when a browser tab is opened.
const BrowserView = defineAsyncComponent(() => import("@/components/browser/BrowserView.vue"));
import OverlaySidebarGroup from "./OverlaySidebarGroup.vue";
import { ask } from "@/platform";
import { Files } from "@lucide/vue";
import { EXPLORER_TAB_ID, SC_TAB_ID, COMMITS_TAB_ID, NOTES_TAB_ID, NEW_TAB_ID, type FilePanelBrowserTab } from "@/types";
import SourceControlTab from "./SourceControlTab.vue";
import CommitsTab from "./CommitsTab.vue";
import FileEditorTab from "./FileEditorTab.vue";
import { useGitOperations } from "@/composables/useGitOperations";
import { usePanelResizeState } from "@/composables/usePanelResizeState";
import { judgedWidth } from "@/lib/overlaySidebar";
import { panelsAnimating } from "@/lib/panelAnimationState";
import { Button } from "./ui/button";
import { useDiffReview } from "@/composables/useDiffReview";
import { useSearchPanelState } from "@/composables/useSearchPanelState";
import type { ReviewContext, ReviewComment } from "@/types/shared";
import { toast } from "vue-sonner";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import {
  readCachedPanelState,
  writeCachedFileExplorerVisible,
} from "@/lib/bootstrapCache";
import { PANEL_SIZES } from "@/lib/panelSizes";
import { scSelectionStillChanged } from "@/lib/scSelectionReconcile";
import type { GitStatus } from "@/types";


const store = useWorkspaceStore();
const {
  allTabs,
  activeId,
  activeTab,
  setActiveId,
  closeTab,
  reorderTabs,
  reorderBrowserTabs,
  setFileDirty,
  isFileDirty,
  updateTabViewState,
  openFile,
  openBrowserTab,
  promoteTab,
  scSelection,
  commitsSelection,
  setScSelection,
  setCommitsSelection,
} = useFilePanelTabs(() => store.activeRoot);

const rootDir = computed(() => store.activeRoot?.path);

const review = useDiffReview();

const scopeKey = computed(() => {
  const r = store.activeRoot;
  return r ? `${r.scopeType}:${r.scopeId}` : null;
});
const searchScopeKey = computed(() => scopeKey.value ?? "");
const { selected: searchSelected } = useSearchPanelState(searchScopeKey);

// Load persisted drafts whenever the scope changes.
watch(scopeKey, (k) => { if (k) void review.loadScope(k); }, { immediate: true });

const scReviewContext = computed<ReviewContext | null>(() => {
  const k = scopeKey.value, sel = scSelection.value;
  if (!k || !sel) return null;
  return { scopeKey: k, source: "sourceControl", relPath: sel.relPath, staged: sel.staged };
});

const commitsReviewContext = computed<ReviewContext | null>(() => {
  const k = scopeKey.value, sel = commitsSelection.value;
  if (!k || !sel) return null;
  return { scopeKey: k, source: "commit", relPath: sel.relPath, commitSha: sel.commitId };
});

const reviewSummary = computed(() => (scopeKey.value ? review.scopeSummary(scopeKey.value) : { total: 0, files: 0 }));
const fileCommentCounts = computed(() => (scopeKey.value ? review.fileCommentCounts(scopeKey.value) : {}));
const activeDirId = computed(() => store.activeRoot?.scopeId ?? "");
const activeCwd = computed(() => store.activeRoot?.path ?? "");
const {
  gitStatus: scGitStatus,
  gitBusy: scGitBusy,
  canPublish: scCanPublish,
  canSyncUpstream: scCanSyncUpstream,
  pull: pullSourceControlBranch,
  push: pushSourceControlBranch,
  publish: publishSourceControlBranch,
} = useGitOperations(() => rootDir.value);

// All browser tabs for the current scope. Each gets a persistently-mounted
// BrowserView (see template) that stays alive in the background — switching
// tabs only toggles visibility, so the <webview>'s WebContents (and thus page
// state, scroll, history) survives instead of being torn down and reloaded.
const browserTabs = computed<FilePanelBrowserTab[]>(
  () => allTabs.value.filter((t): t is FilePanelBrowserTab => t.kind === "browser"),
);

// Background browser tabs are display:none, so their hidden <webview>s don't
// track resizes and would snap to the new size when next shown. After a resize
// settles, briefly lay out the background tabs (displayed but visibility:hidden)
// so their webviews pre-size to the new dimensions — no jump on tab switch.
const browserLayer = ref<HTMLElement | null>(null);
const browserRelayout = ref(false);
let browserResizeObserver: ResizeObserver | null = null;
let browserResizeTimer: ReturnType<typeof setTimeout> | null = null;
let browserRelayoutTimer: ReturnType<typeof setTimeout> | null = null;

function browserTabStyle(tabId: string): Record<string, string> {
  if (tabId === activeTab.value?.id) return { zIndex: "1" };
  if (browserRelayout.value) return { visibility: "hidden", zIndex: "0" };
  return { display: "none" };
}

onMounted(() => {
  if (!browserLayer.value) return;
  browserResizeObserver = new ResizeObserver(() => {
    if (browserResizeTimer) clearTimeout(browserResizeTimer);
    // Debounce to detect "resize ended", then hold the relayout pass long
    // enough for Electron to push new bounds to the guest webviews.
    browserResizeTimer = setTimeout(() => {
      browserRelayout.value = true;
      if (browserRelayoutTimer) clearTimeout(browserRelayoutTimer);
      browserRelayoutTimer = setTimeout(() => { browserRelayout.value = false; }, 250);
    }, 150);
  });
  browserResizeObserver.observe(browserLayer.value);
});

onUnmounted(() => {
  browserResizeObserver?.disconnect();
  browserResizeObserver = null;
  if (browserResizeTimer) clearTimeout(browserResizeTimer);
  if (browserRelayoutTimer) clearTimeout(browserRelayoutTimer);
});

function handleSwitchScView(v: "changes" | "history") {
  setActiveId(v === "history" ? COMMITS_TAB_ID : SC_TAB_ID);
}

// Navigator "jump to comment": switch to the right panel and open that diff.
async function handleJumpToComment(c: ReviewComment) {
  if (c.source === "commit" && c.commitSha) {
    setActiveId(COMMITS_TAB_ID);
    await handleOpenCommitDiff(c.relPath, c.commitSha, c.commitSha.slice(0, 7));
  } else {
    setActiveId(SC_TAB_ID);
    await handleOpenGitDiff(c.relPath, c.staged ?? false);
  }
}

/** The width this panel is about to occupy, known by App.vue before the panel
 *  has laid out. Lets the inner sidebars pick docked vs overlay on the very
 *  first render instead of a frame after mount. */
const props = defineProps<{ expectedWidth?: number }>();

const cached = readCachedPanelState();

// One observer for the whole right panel — every inner sidebar derives its
// docked/overlay mode from this width, so they must not each measure.
//
// Seeded from `expectedWidth` rather than starting at 0: this component
// remounts on every open, and the inner sidebars' docked/overlay rule runs
// immediately during setup. With a 0 width it can't decide, so it decided again
// after mount once the observer reported — one frame late, and visible as the
// panel's contents rearranging just after it appeared.
const panelEl = ref<HTMLElement | null>(null);
const panelWidth = ref(props.expectedWidth ?? 0);
// What the inner sidebars judge docked-vs-overlay against. While anything is
// sliding the measurement sweeps, so the known target wins; otherwise the
// measurement is the truth (drags, window resizes).
const settledWidth = computed(() =>
  judgedWidth(panelWidth.value, props.expectedWidth, panelsAnimating.value),
);
let panelObserver: ResizeObserver | null = null;
provide("rightPanelWidth", panelWidth);

const clampListPanelPx = (value: number) =>
  Math.min(PANEL_SIZES.list.max, Math.max(PANEL_SIZES.list.min, value));

const explorer = usePanelResizeState({
  cacheKey: "explorer",
  pxStateKey: "panel_explorer_px",
  initialPx: clampListPanelPx(cached.explorerPx ?? PANEL_SIZES.list.defaults.explorer),
  clamp: clampListPanelPx,
  visibleStateKey: "file_explorer_visible",
  initialVisible: cached.fileExplorerVisible,
  writeCachedVisible: writeCachedFileExplorerVisible,
  containerWidth: settledWidth,
});



const search = usePanelResizeState({
  cacheKey: "search",
  pxStateKey: "search_list_px",
  initialPx: clampListPanelPx(cached.searchPx ?? PANEL_SIZES.list.defaults.search),
  clamp: clampListPanelPx,
  containerWidth: settledWidth,
});

watch(searchSelected, () => search.dismissOverlay());

// Palette lives in App.vue now (so it works with the right panel collapsed);
// open it via the same window event the global shortcuts use.
function handleOpenFileSearch() { window.dispatchEvent(new CustomEvent("open-file-search")); }

// ⌘W routed here when focus is in the file panel — close the active file tab
// (synthetic SC/Commits/Explorer tabs are pinned and ignored).
function handleCloseActiveFileTab() {
  const t = activeTab.value;
  if (t?.kind === "file") closeFileTab(t.id);
}

// Reveal the FileExplorer tree and make sure it's actually mounted. The tree
// lives in the file/explorer view's left split — when an SC/Commits view is
// active (or activeId points at a stale synthetic id) it isn't mounted, so
// switch to a file tab if one exists, else the explorer placeholder. EXPLORER_TAB
// is only in allTabs when there are no file tabs, so never force it otherwise.
function revealExplorer() {
  explorer.open.value = true;
  const t = activeTab.value;
  if (t?.kind === "file" || t?.kind === "explorer") return;
  const lastFile = [...allTabs.value].reverse().find((x) => x.kind === "file");
  setActiveId(lastFile ? lastFile.id : EXPLORER_TAB_ID);
}

// ⌘⇧E / ⌃⇧G — reveal the explorer tree or the Source Control view.
function handleFocusFilePanel(e: Event) {
  const view = (e as CustomEvent<string>).detail;
  if (view === "sc") setActiveId(SC_TAB_ID);
  else if (view === "notes") setActiveId(NOTES_TAB_ID);
  else revealExplorer();
}

function handleCloseGitDiff(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (!detail) return;
  const sel = scSelection.value;
  if (!sel) return;
  if (detail.all || detail.relPath === sel.relPath) {
    setScSelection(null);
  }
}

// Close the open SC diff when its file is no longer changed — covers external
// commits/discards (agent in a terminal) that only surface as a status refresh,
// not just the in-app `close-git-diff` paths. Status here is emitted by the
// active scope's ChangesPanel, so it lines up with the active scSelection.
function handleScStatusChanged(s: GitStatus | null) {
  scGitStatus.value = s;
  const sel = scSelection.value;
  if (sel && !scSelectionStillChanged(s, sel.relPath, sel.staged)) {
    setScSelection(null);
  }
}

onMounted(async () => {
  if (panelEl.value && typeof ResizeObserver === "function") {
    panelWidth.value = panelEl.value.clientWidth;
    panelObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) panelWidth.value = w;
    });
    panelObserver.observe(panelEl.value);
  }

  window.addEventListener("close-git-diff", handleCloseGitDiff);
  window.addEventListener("close-active-file-tab", handleCloseActiveFileTab);
  window.addEventListener("focus-file-panel", handleFocusFilePanel);
  window.addEventListener("new-file", handleNewFile);

  const rpc = useRpc();
  try {
    const [explorerPx, vis, searchPx] = await Promise.all([
      rpc.request.getAppState({ key: "panel_explorer_px" }),
      rpc.request.getAppState({ key: "file_explorer_visible" }),
      rpc.request.getAppState({ key: "search_list_px" }),
    ]);
    explorer.applyPersisted(explorerPx, vis);
    search.applyPersisted(searchPx);
  } catch {}
});
onUnmounted(() => {
  window.removeEventListener("close-git-diff", handleCloseGitDiff);
  window.removeEventListener("close-active-file-tab", handleCloseActiveFileTab);
  window.removeEventListener("focus-file-panel", handleFocusFilePanel);
  window.removeEventListener("new-file", handleNewFile);
  panelObserver?.disconnect();
  panelObserver = null;
  explorer.dispose();
  search.dispose();
});

watch(activeTab, (tab) => {
  if (tab?.kind === "explorer") explorer.open.value = true;
});

async function handleNewFile() {
  revealExplorer();
  await nextTick();
  window.dispatchEvent(new CustomEvent("explorer-new-file"));
}

const activeFilePath = computed(() => {
  const t = activeTab.value;
  return t?.kind === "file" ? t.filePath : null;
});

async function discardUnsavedFile(path: string) {
  window.dispatchEvent(new CustomEvent("clear-dirty-cache", { detail: path }));
  setFileDirty(path, false);
  const root = rootDir.value;
  if (!root || !path.startsWith(root + "/")) return;
  try {
    await useRpc().request.shadowRemove({
      dir: root,
      relPath: path.slice(root.length + 1),
    });
  } catch {}
}

async function closeFileTab(id: string) {
  if (!isFileDirty(id)) {
    closeTab(id);
    return;
  }
  const label = id.split("/").pop() || id;
  const ok = await ask(
    `Discard unsaved changes to ${label}? This action cannot be undone.`,
    { title: "Unsaved Changes", kind: "warning" },
  );
  if (!ok) return;
  await discardUnsavedFile(id);
  closeTab(id);
}

async function handleOpenGitDiff(relPath: string, staged: boolean) {
  const dirPath = rootDir.value;
  if (!dirPath) return;
  try {
    const result = await useRpc().request.gitDiff({ path: dirPath, file: relPath, staged });
    const sel: ScSelection = {
      relPath, staged,
      original: result.original, modified: result.modified,
    };
    setScSelection(sel);
  } catch (e) { console.error("git diff:", e); }
}

async function handleOpenCommitDiff(filePath: string, commitId: string, shortId: string) {
  const dirPath = rootDir.value;
  if (!dirPath) return;
  try {
    const result = await useRpc().request.gitCommitFileDiff({ path: dirPath, commitId, file: filePath });
    const sel: CommitsSelection = {
      relPath: filePath, commitId, commitShortId: shortId,
      original: result.original, modified: result.modified,
    };
    setCommitsSelection(sel);
  } catch (e) { console.error("commit diff:", e); }
}

async function handleOpenFileFromSc(absPath: string) {
  // Binary files in SC fall through here — open as a file tab.
  openFile(absPath);
}

const scDiffFilePath = computed(() => {
  const sel = scSelection.value;
  if (!sel || !rootDir.value) return null;
  return `${rootDir.value}/${sel.relPath}`;
});


async function discardScFile(relPath: string) {
  const dirPath = rootDir.value;
  if (!relPath || !dirPath) return;
  const ok = await ask(
    `Discard all changes to ${relPath}? This action cannot be undone.`,
    { title: "Discard file changes", kind: "warning" },
  );
  if (!ok) return;
  try {
    await useRpc().request.gitDiscardFiles({ path: dirPath, files: [relPath] });
    if (scSelection.value?.relPath === relPath) setScSelection(null);
    toast.success(`Discarded ${relPath}`);
  } catch (e) {
    toast.error(`Discard failed: ${e}`);
  }
}

function revertScFile() {
  const sel = scSelection.value;
  if (!sel) return;
  void discardScFile(sel.relPath);
}
</script>

<template>
  <div ref="panelEl" data-file-panel class="h-full flex flex-col overflow-hidden bg-sidebar">
    <FileTabBar
      :tabs="allTabs"
      :active-id="activeId"
      :is-file-dirty="isFileDirty"
      :root-dir="rootDir"
      @select="setActiveId"
      @close="closeFileTab"
      @reorder="reorderTabs"
      @reorder-browser="reorderBrowserTabs"
      @promote="promoteTab"
    />

    <template v-if="activeTab?.kind === 'notes' && store.activeRoot">
      <div class="h-full flex flex-col overflow-hidden flex-1 min-h-0">
        <NotesPanel :directory-id="store.activeRoot.scopeId" class="flex-1 min-h-0" />
      </div>
    </template>

    <template v-else-if="activeTab?.kind === 'search' && rootDir && scopeKey">
      <div class="h-full flex flex-col overflow-hidden flex-1 min-h-0">
        <div class="flex-1 min-h-0">
          <OverlaySidebarGroup :state="search" :container-width="panelWidth">
            <template #sidebar>
              <SearchPanel
                :scope-key="scopeKey"
                :root-dir="rootDir"
                class="h-full"
                @open-result="search.dismissOverlay()"
              />
            </template>
            <template #content>
              <SearchPreview
                v-if="searchSelected"
                :match="searchSelected"
                :root-dir="rootDir"
                :list-visible="search.open.value"
                @update:list-visible="search.open.value = $event"
              />
              <div v-else class="flex h-full flex-col bg-sidebar">
                <SearchPreviewHeader
                  :match="null"
                  :list-visible="search.open.value"
                  @update:list-visible="search.open.value = $event"
                />
                <div class="flex flex-1 items-center justify-center">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><Files /></EmptyMedia>
                      <EmptyTitle>No Preview</EmptyTitle>
                      <EmptyDescription>Select a result to preview the file.</EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent />
                  </Empty>
                </div>
              </div>
            </template>
          </OverlaySidebarGroup>
        </div>
      </div>
    </template>

    <div
      v-else-if="activeTab?.kind !== 'browser' && activeTab?.kind !== 'newTab' && activeTab?.kind !== 'file' && activeTab?.kind !== 'explorer' && activeTab?.kind !== 'sourceControl' && activeTab?.kind !== 'commits'"
      class="flex h-full items-center justify-center bg-sidebar"
    >
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Files /></EmptyMedia>
          <EmptyTitle>No Files Open</EmptyTitle>
          <EmptyDescription>Open an existing file or create a new one.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div class="flex gap-2">
            <Button size="sm" variant="outline" @click="handleOpenFileSearch">Open File</Button>
            <Button size="sm" variant="outline" @click="handleNewFile">New File</Button>
          </div>
        </EmptyContent>
      </Empty>
    </div>

    <!-- Source control views: live outside the v-if chain (like FileEditorTab) so
         both sub-views (Changes, History) stay cached simultaneously. KeepAlive
         preserves inner scroll/virtualizer state across sub-view switches. -->
    <KeepAlive>
      <SourceControlTab
        v-if="activeTab?.kind === 'sourceControl' && rootDir"
        :root-dir="rootDir"
        :scope-key="scopeKey"
        :active-dir-id="activeDirId"
        :active-cwd="activeCwd"
        :selection="scSelection"
        :comment-counts="fileCommentCounts"
        :review-total="reviewSummary.total"
        :review-context="scReviewContext ?? undefined"
        :git-status="scGitStatus"
        :git-busy="scGitBusy"
        :can-publish="scCanPublish"
        :can-sync-upstream="scCanSyncUpstream"
        @open-file="handleOpenFileFromSc"
        @open-diff="handleOpenGitDiff"
        @discard="discardScFile"
        @status-changed="handleScStatusChanged"
        @jump="handleJumpToComment"
        @revert="revertScFile"
        @pull="pullSourceControlBranch"
        @push="pushSourceControlBranch"
        @publish="publishSourceControlBranch"
        @switch-view="handleSwitchScView"
      />
    </KeepAlive>
    <KeepAlive>
      <CommitsTab
        v-if="activeTab?.kind === 'commits' && rootDir"
        :root-dir="rootDir"
        :scope-key="scopeKey"
        :active-dir-id="activeDirId"
        :active-cwd="activeCwd"
        :selection="commitsSelection"
        :review-total="reviewSummary.total"
        :review-context="commitsReviewContext ?? undefined"
        @open-diff="handleOpenCommitDiff"
        @jump="handleJumpToComment"
        @switch-view="handleSwitchScView"
      />
    </KeepAlive>

    <!-- File/editor view, cached with KeepAlive instead of living in the
         v-if/v-else-if chain. Switching to a non-file tab (Changes, History,
         Notes, Search) deactivates rather than unmounts it, so the FileExplorer
         tree's in-memory state (expanded folders, scroll, selection) and its fs
         watcher survive — no reload + re-expand on return. KeepAlive (vs v-show)
         removes it from the DOM while inactive, so the ResizablePanel/editor
         re-measure correctly on reactivation instead of being stuck at 0 width. -->
    <KeepAlive>
      <FileEditorTab
        v-if="activeTab?.kind === 'file' || activeTab?.kind === 'explorer'"
        :active-tab="activeTab"
        :root-dir="rootDir"
        :explorer="explorer"
        :active-file-path="activeFilePath"
        @open-file="(p, perm) => openFile(p, undefined, perm ? { permanent: true } : undefined)"
        @close-tab="closeFileTab"
        @dirty="(path, d) => setFileDirty(path, d)"
        @view-state="(id, s) => updateTabViewState(id, s)"
        @open-file-search="handleOpenFileSearch"
        @new-file="handleNewFile"
      />
    </KeepAlive>

    <!-- Persistent browser layer. Lives OUTSIDE the v-if/v-else-if chain above so
         it's never unmounted by a tab switch: every open browser tab keeps its
         own BrowserView (and live <webview>) mounted. Only visibility toggles —
         the whole layer hides (display:none) when a non-browser tab is active,
         and within it each tab shows only when it's the active one. Keeping the
         node in the DOM is what preserves the page instead of reloading it. -->
    <div v-show="activeTab?.kind === 'browser'" ref="browserLayer" class="relative flex-1 min-h-0">
      <BrowserView
        v-for="tab in browserTabs"
        :key="tab.id"
        :style="browserTabStyle(tab.id)"
        :tab-id="tab.id"
        :url="tab.browserUrl"
        :workspace-dir="activeCwd"
        :directory-id="activeDirId"
        :active="tab.id === activeTab?.id"
        class="absolute inset-0"
        @open-new-tab="(url) => openBrowserTab(url)"
      />
    </div>

    <!-- New-tab page: the pinned Globe shows the browser address bar in a blank
         state. Committing a URL here spawns a real browser tab (and switches to
         it), instead of navigating in place. Mounted on demand (v-if) — it holds
         no page state to preserve, so no need for a permanent idle webview. -->
    <div v-if="activeTab?.kind === 'newTab'" class="flex-1 min-h-0">
      <BrowserView
        new-tab-mode
        :tab-id="NEW_TAB_ID"
        url="about:blank"
        :workspace-dir="activeCwd"
        :active="activeTab?.kind === 'newTab'"
        class="h-full w-full"
        @navigate-new-tab="(url) => openBrowserTab(url)"
        @open-new-tab="(url) => openBrowserTab(url)"
      />
    </div>

  </div>
</template>
