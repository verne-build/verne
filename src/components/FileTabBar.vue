<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, reactive, watch } from "vue";
import type { FilePanelTab, FilePanelBrowserTab } from "@/types";
import { COMMITS_TAB_ID } from "@/types";
import { X, GitBranch, Files, Maximize2, Minimize2, PencilLine, Globe, Asterisk, Search } from "@lucide/vue";
import { toast } from "vue-sonner";
import { DragDropProvider } from "@dnd-kit/vue";
import { closestCorners } from "@dnd-kit/collision";
import type { CollisionDetector } from "@dnd-kit/abstract";
import SortableItem from "@/components/dnd/SortableItem.vue";
import { sortableSensors } from "@/components/dnd/sensors";
import {
  setDraggedPath,
  PASTE_PATH_EVENT,
  PASTE_PATH_ENTER_EVENT,
  PASTE_PATH_LEAVE_EVENT,
} from "@/lib/dropPath";
import FileIcon from "./FileIcon.vue";
import { useRpc } from "@/composables/useRpc";
import { addToAgent } from "@/composables/useAddToAgent";
import { useShortcuts } from "@/composables/useShortcuts";
import { TabBar, TabBarTrigger } from "./ui/tab-bar";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import PanelRightFilled from "./icons/PanelRightFilled.vue";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "./ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";

const props = defineProps<{
  tabs: FilePanelTab[];
  activeId: string | null;
  isFileDirty: (path: string) => boolean;
  rootDir?: string;
  maximized?: boolean;
}>();

const shortcuts = useShortcuts();

const emit = defineEmits<{
  select: [id: string];
  close: [id: string];
  toggleRight: [];
  reorder: [ids: string[]];
  reorderBrowser: [ids: string[]];
  toggleMaximize: [];
  promote: [id: string];
}>();

function isClosable(t: FilePanelTab) {
  return t.kind === "file" || t.kind === "browser";
}

function isDirty(t: FilePanelTab) {
  return t.kind === "file" && props.isFileDirty(t.filePath);
}

function closableTabs() {
  return props.tabs.filter(isClosable);
}

function closeIds(ids: string[]) {
  for (const id of ids) emit("close", id);
}

function closeOthers(id: string) {
  closeIds(closableTabs().filter(t => t.id !== id).map(t => t.id));
}

function closeSaved() {
  closeIds(closableTabs().filter(t => !isDirty(t)).map(t => t.id));
}

function closeAll() {
  closeIds(closableTabs().map(t => t.id));
}

function hasOthers(id: string) {
  return closableTabs().some(t => t.id !== id);
}

function hasSaved() {
  return closableTabs().some(t => !isDirty(t));
}

function tabAbsPath(t: FilePanelTab): string | null {
  if (t.kind === "file") return t.filePath;
  return null;
}

function tabRelPath(t: FilePanelTab): string | null {
  if (t.kind === "file") {
    const root = props.rootDir;
    if (root && t.filePath.startsWith(root + "/")) return t.filePath.slice(root.length + 1);
    return t.filePath;
  }
  return null;
}

async function copy(text: string | null, label: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${label}`);
  } catch (e) {
    toast.error(`Copy failed: ${e}`);
  }
}

function copyAbs(t: FilePanelTab) { copy(tabAbsPath(t), "path"); }
function copyRel(t: FilePanelTab) { copy(tabRelPath(t), "relative path"); }

function addToAgentTab(t: FilePanelTab) {
  const path = tabAbsPath(t);
  if (path) void addToAgent(path);
}

async function revealInFinder(t: FilePanelTab) {
  const path = tabAbsPath(t);
  if (!path) return;
  try {
    await useRpc().request.revealInFinder({ path });
  } catch (e) {
    toast.error(`Reveal failed: ${e}`);
  }
}

function isSortable(t: FilePanelTab) {
  return t.kind === "file" || t.kind === "browser";
}

const browserSortableIds = computed(() => browserStripTabs.value.map(t => t.id));
const fileSortableIds = computed(() =>
  fileStripTabs.value.filter(t => t.kind === "file").map(t => t.id),
);

const pinnedTabs = computed(() =>
  props.tabs.filter(t =>
    t.kind === "sourceControl" || t.kind === "notes" || t.kind === "search",
  ),
);
// Browser tabs render as their own group at the start of the strip; file +
// explorer tabs follow after a divider.
const browserStripTabs = computed(() =>
  props.tabs.filter((t): t is FilePanelBrowserTab => t.kind === "browser"),
);
const fileStripTabs = computed(() =>
  props.tabs.filter(t => t.kind === "file" || t.kind === "explorer"),
);
// Explorer is a synthetic tab shown only when no files are open. It pins to the
// left of the divider with the other pinned icons; real file tabs scroll.
const explorerTab = computed(() => props.tabs.find(t => t.kind === "explorer") ?? null);
const fileTabsOnly = computed(() => props.tabs.filter(t => t.kind === "file"));
// Synthetic "new tab page" pinned button (Globe). Selecting it shows the browser
// address bar in a blank state; navigating from there spawns a real browser tab.
const newTabTab = computed(() => props.tabs.find(t => t.kind === "newTab") ?? null);
const dirtyFileIds = computed(() =>
  fileStripTabs.value
    .filter((t): t is Extract<FilePanelTab, { kind: "file" }> => t.kind === "file")
    .filter(t => props.isFileDirty(t.filePath))
    .map(t => t.id),
);
const dirtyFileSignature = computed(() => dirtyFileIds.value.join("\n"));

// Per-tab favicon load error flag; keyed by tab id. True = use Asterisk fallback.
const faviconError = reactive<Record<string, boolean>>({});
function onFaviconError(id: string) { faviconError[id] = true; }
function hasFavicon(tab: FilePanelBrowserTab) { return !!tab.faviconUrl && !faviconError[tab.id]; }

const scrollEl = ref<HTMLElement | null>(null);
const fadeLeft = ref(false);
const fadeRight = ref(false);
let resizeObs: ResizeObserver | null = null;

function updateFades() {
  const el = scrollEl.value;
  if (!el) return;
  const { scrollLeft, clientWidth, scrollWidth } = el;
  fadeLeft.value = scrollLeft > 0;
  fadeRight.value = scrollLeft + clientWidth < scrollWidth - 1;
}

onMounted(async () => {
  await nextTick();
  const el = scrollEl.value;
  if (!el) return;
  el.addEventListener("scroll", updateFades, { passive: true });
  resizeObs = new ResizeObserver(updateFades);
  resizeObs.observe(el);
  const inner = el.firstElementChild as HTMLElement | null;
  if (inner) resizeObs.observe(inner);
  updateFades();
  // Fresh mount (e.g. right panel just expanded) won't trigger the activeId
  // watcher, so scroll the already-active tab into view explicitly.
  void scrollActiveIntoView(props.activeId);
});

onBeforeUnmount(() => {
  scrollEl.value?.removeEventListener("scroll", updateFades);
  resizeObs?.disconnect();
  resizeObs = null;
});

const FADE_PX = 32;
async function scrollActiveIntoView(id: string | null) {
  const el = scrollEl.value;
  if (!id || !el) return;
  await nextTick();
  const tabEl = el.querySelector(
    `[data-tab-id="${CSS.escape(id)}"]`,
  ) as HTMLElement | null;
  if (!tabEl) return;
  const vRect = el.getBoundingClientRect();
  const tRect = tabEl.getBoundingClientRect();
  const tabLeft = tRect.left - vRect.left + el.scrollLeft;
  const tabRight = tabLeft + tRect.width;
  const viewLeft = el.scrollLeft;
  const viewRight = viewLeft + el.clientWidth;
  // Only scroll when the tab is actually clipped — leaving visible tabs put
  // avoids the bar jumping as you close tabs.
  if (tabLeft < viewLeft) {
    el.scrollLeft = Math.max(0, tabLeft - FADE_PX);
  } else if (tabRight > viewRight) {
    el.scrollLeft = tabRight - el.clientWidth + FADE_PX;
  }
  updateFades();
}

watch(() => props.activeId, scrollActiveIntoView);
watch(
  dirtyFileSignature,
  async () => {
    const activeId = props.activeId;
    if (activeId && dirtyFileIds.value.includes(activeId)) {
      await scrollActiveIntoView(activeId);
    }
  },
  { flush: "post" },
);

function browserIndexFor(id: string): number {
  return browserSortableIds.value.indexOf(id);
}
function fileIndexFor(id: string): number {
  return fileSortableIds.value.indexOf(id);
}

// Out-of-bar = extract: while the cursor sits inside the tab row, reorder
// normally; once it leaves (e.g. dragging down onto a terminal), report no
// collision so dnd-kit drops the reorder target and siblings snap back. The
// drag then resolves as a path-paste in onDragEnd.
const barRowRef = ref<HTMLElement | null>(null);
const tabBarCollision: CollisionDetector = (input) => {
  const el = barRowRef.value;
  const pos = input.dragOperation?.position?.current;
  if (el && pos) {
    const r = el.getBoundingClientRect();
    const pad = 8; // slack so edge tabs stay reachable without flicker
    if (pos.y < r.top - pad || pos.y > r.bottom + pad ||
        pos.x < r.left - pad || pos.x > r.right + pad) {
      return null;
    }
  }
  return closestCorners(input);
};

// dnd-kit is pointer-based, so track the cursor (capture phase, ahead of
// dnd-kit's own listeners) to know where the tab was released — and drive the
// terminal's drop highlight by hand since no native dragover fires.
let lastPointer: { x: number; y: number } | null = null;
let hoverTerminal: Element | null = null;
function terminalAt(x: number, y: number): Element | null {
  return document
    .elementsFromPoint(x, y)
    .map(el => el.closest("[data-terminal-drop]"))
    .find(Boolean) ?? null;
}
function trackPointer(e: PointerEvent) {
  lastPointer = { x: e.clientX, y: e.clientY };
  const next = terminalAt(e.clientX, e.clientY);
  if (next === hoverTerminal) return;
  hoverTerminal?.dispatchEvent(new CustomEvent(PASTE_PATH_LEAVE_EVENT));
  next?.dispatchEvent(new CustomEvent(PASTE_PATH_ENTER_EVENT));
  hoverTerminal = next;
}
function clearHoverTerminal() {
  hoverTerminal?.dispatchEvent(new CustomEvent(PASTE_PATH_LEAVE_EVENT));
  hoverTerminal = null;
}

interface DragStartPayload {
  operation: { source: { id?: string } | null };
}
function onDragStart(e: DragStartPayload) {
  const id = e.operation.source?.id;
  const tab = id ? props.tabs.find(t => t.id === id) : undefined;
  setDraggedPath(tab ? tabAbsPath(tab) : null);
  lastPointer = null;
  window.addEventListener("pointermove", trackPointer, { capture: true });
}

interface DragEndPayload {
  operation: { source: { id?: string; initialIndex?: number; index?: number } | null };
  canceled: boolean;
}
function onDragEnd(e: DragEndPayload) {
  window.removeEventListener("pointermove", trackPointer, { capture: true });
  clearHoverTerminal();
  // Dropped over a terminal? Paste the path instead of reordering.
  const tab = props.tabs.find(t => t.id === e.operation.source?.id);
  const path = tab ? tabAbsPath(tab) : null;
  if (path && lastPointer) {
    const target = terminalAt(lastPointer.x, lastPointer.y);
    if (target) {
      target.dispatchEvent(new CustomEvent(PASTE_PATH_EVENT, { detail: path }));
      setDraggedPath(null);
      return;
    }
  }
  setDraggedPath(null);
  if (e.canceled) return;
  const src = e.operation.source;
  if (!src) return;
  const from = src.initialIndex ?? -1;
  const to = src.index ?? -1;
  if (from < 0 || to < 0 || from === to) return;
  // Reorder within the group the dragged tab belongs to; the two groups have
  // independent index spaces.
  const isBrowser = src.id != null && browserSortableIds.value.includes(src.id);
  const ids = isBrowser ? [...browserSortableIds.value] : [...fileSortableIds.value];
  if (from >= ids.length || to >= ids.length) return;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  if (isBrowser) emit("reorderBrowser", ids);
  else emit("reorder", ids);
}
</script>

<template>
  <TooltipProvider :delay-duration="250">
    <TabBar variant="pill" class="px-1.5 gap-0.5 bg-sidebar">
      <!-- Pinned tabs: SC + Commits, never scroll -->
      <div class="flex items-center gap-0.5 h-11.5 shrink-0">
        <template v-for="tab in pinnedTabs" :key="tab.id">
          <Tooltip v-if="tab.kind === 'sourceControl'">
            <TooltipTrigger as-child>
              <TabBarTrigger
                :active="activeId === tab.id || activeId === COMMITS_TAB_ID"
                variant="pill"
                class="px-1.5 transition-none"
                @click="emit('select', tab.id)"
              >
                <GitBranch class="size-3.5 shrink-0" />
              </TabBarTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Source Control</TooltipContent>
          </Tooltip>
          <Tooltip v-else-if="tab.kind === 'notes'">
            <TooltipTrigger as-child>
              <TabBarTrigger
                :active="activeId === tab.id"
                variant="pill"
                class="px-1.5 transition-none"
                @click="emit('select', tab.id)"
              >
                <PencilLine class="size-3.5 shrink-0" />
              </TabBarTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Notes</TooltipContent>
          </Tooltip>
          <Tooltip v-else-if="tab.kind === 'search'">
            <TooltipTrigger as-child>
              <TabBarTrigger
                :active="activeId === tab.id"
                variant="pill"
                class="px-1.5 transition-none"
                @click="emit('select', tab.id)"
              >
                <Search class="size-3.5 shrink-0" />
              </TabBarTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search</TooltipContent>
          </Tooltip>
        </template>
        <Tooltip v-if="newTabTab">
          <TooltipTrigger as-child>
            <TabBarTrigger
              :active="activeId === newTabTab.id"
              variant="pill"
              class="px-1.5 transition-none"
              tabindex="0"
              @click="emit('select', newTabTab.id)"
            >
              <Globe class="size-3.5 shrink-0" />
            </TabBarTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Browser</TooltipContent>
        </Tooltip>
        <Tooltip v-if="explorerTab">
          <TooltipTrigger as-child>
            <TabBarTrigger
              :active="activeId === explorerTab.id"
              variant="pill"
              class="px-1.5 transition-none"
              :data-tab-id="explorerTab.id"
              @click="emit('select', explorerTab.id)"
            >
              <Files class="size-3.5 shrink-0" />
            </TabBarTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Files</TooltipContent>
        </Tooltip>
      </div>

      <!-- Divider between pinned tabs and the scrollable strip (browser or file
           tabs, whichever comes first). Always present when the strip has tabs. -->
      <div
        v-if="browserStripTabs.length || fileTabsOnly.length"
        aria-hidden="true"
        class="self-center mx-1 h-5 w-px bg-border shrink-0"
      />

      <!-- Scrollable tabs: Explorer (when empty) + file tabs -->
      <DragDropProvider :sensors="sortableSensors" @drag-start="onDragStart" @drag-end="onDragEnd">
      <div class="relative flex-1 min-w-0 h-11.5 flex items-stretch">
        <div
          ref="scrollEl"
          class="h-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div ref="barRowRef" class="flex items-center h-11.5 gap-0.5">
            <!-- Browser tab group -->
            <SortableItem
              v-for="tab in browserStripTabs"
              :key="tab.id"
              :id="tab.id"
              :index="browserIndexFor(tab.id)"
              :collision-detector="tabBarCollision"
              group="browser-tabs"
              class="inline-flex shrink-0"
            >
              <TabBarTrigger
                :active="activeId === tab.id"
                variant="pill"
                class="group gap-1.5 pl-1.5 pr-1.5 transition-none overflow-hidden data-[dragging=true]:opacity-50"
                :data-tab-id="tab.id"
                @click="emit('select', tab.id)"
              >
                <img
                  v-if="hasFavicon(tab)"
                  :src="tab.faviconUrl"
                  class="size-3.5 shrink-0 object-contain"
                  alt=""
                  @error="onFaviconError(tab.id)"
                />
                <Asterisk v-else class="size-3.5 shrink-0" />
                <!-- Cap width: long page titles get truncated with an ellipsis;
                     native title attr reveals the full label on hover.
                     overflow-clip (not hidden) clips WITHOUT making the span a
                     scroll container, so it never traps wheel-scroll over the
                     tab strip. -->
                <span class="overflow-clip text-ellipsis whitespace-nowrap max-w-[166px]" :title="tab.label">{{ tab.label }}</span>
                <span
                  class="pointer-events-none hidden group-hover:block absolute right-0 top-0 bottom-0 w-12 bg-linear-to-r from-transparent via-tab-active-bg to-tab-active-bg"
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  data-no-drag
                  class="size-5 hidden group-hover:inline-flex absolute right-1 top-1/2 z-10 -translate-y-1/2 transition-none"
                  tabindex="0"
                  @click.stop="emit('close', tab.id)"
                >
                  <X />
                </Button>
              </TabBarTrigger>
            </SortableItem>

            <!-- Divider between browser and file groups. pointer-events-none so
                 wheel events fall through to the scroll viewport instead of
                 hit-testing this tiny non-scrollable element (which stalls the
                 native vertical-wheel→horizontal-scroll behavior). -->
            <div
              v-if="browserStripTabs.length"
              aria-hidden="true"
              class="pointer-events-none self-center mx-1 h-5 w-px bg-border shrink-0"
            />

            <!-- File group: file tabs (Explorer pins to the left of the divider) -->
            <template v-for="tab in fileTabsOnly" :key="tab.id">
              <!-- File tabs -->
              <SortableItem
                v-if="tab.kind === 'file'"
                :id="tab.id"
                :index="fileIndexFor(tab.id)"
                :disabled="!isSortable(tab)"
                :collision-detector="tabBarCollision"
                group="file-tabs"
                class="inline-flex shrink-0"
              >
              <ContextMenu>
                <ContextMenuTrigger as-child>
                  <TabBarTrigger
                    :active="activeId === tab.id"
                    variant="pill"
                    class="group gap-1.5 pl-1.5 pr-1.5 transition-none overflow-hidden data-[dragging=true]:opacity-50"
                    :data-tab-id="tab.id"
                    @click="emit('select', tab.id)"
                    @dblclick="emit('promote', tab.id)"
                  >
                    <FileIcon :name="tab.label" :size="14" />
                    <span class="whitespace-nowrap" :class="{ italic: tab.ephemeral }">{{ tab.label }}</span>
                    <span
                      v-if="tab.filePath && isFileDirty(tab.filePath)"
                      class="size-1.5 rounded-full bg-muted-foreground shrink-0"
                    />
                    <span
                      class="pointer-events-none hidden group-hover:block absolute right-0 top-0 bottom-0 w-12 bg-linear-to-r from-transparent via-tab-active-bg to-tab-active-bg"
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      data-no-drag
                      class="size-5 hidden group-hover:inline-flex absolute right-1 top-1/2 z-10 -translate-y-1/2 transition-none"
                      tabindex="0"
                      @click.stop="emit('close', tab.id)"
                    >
                      <X />
                    </Button>
                  </TabBarTrigger>
                </ContextMenuTrigger>
                <ContextMenuContent @close-auto-focus.prevent>
                  <ContextMenuItem @select="emit('close', tab.id)">Close</ContextMenuItem>
                  <ContextMenuItem :disabled="!hasOthers(tab.id)" @select="closeOthers(tab.id)">
                    Close Others
                  </ContextMenuItem>
                  <ContextMenuItem :disabled="!hasSaved()" @select="closeSaved()">
                    Close Saved
                  </ContextMenuItem>
                  <ContextMenuItem @select="closeAll()">Close All</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="addToAgentTab(tab)">Add to Agent</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="copyAbs(tab)">Copy Path</ContextMenuItem>
                  <ContextMenuItem @select="copyRel(tab)">Copy Relative Path</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="revealInFinder(tab)">Reveal in Finder</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              </SortableItem>
            </template>
          </div>
        </div>
        <!-- Left fade — extends -0.5 to cover the flex-gap seam with pinned tabs -->
        <div
          v-show="fadeLeft"
          aria-hidden="true"
          class="pointer-events-none absolute top-0 bottom-px -left-0.5 w-8 bg-linear-to-r from-sidebar to-transparent z-10"
        />
        <!-- Right fade — extends +0.5 to cover the flex-gap seam with actions -->
        <div
          v-show="fadeRight"
          aria-hidden="true"
          class="pointer-events-none absolute top-0 bottom-px -right-0.5 w-8 bg-linear-to-l from-sidebar to-transparent z-10"
        />
      </div>
      </DragDropProvider>

      <template #actions>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              size="icon-xs"
              variant="ghost"
              :class="['ml-0.5', props.maximized ? 'text-foreground' : 'text-muted-foreground hover:text-foreground']"
              tabindex="0"
              @click="emit('toggleMaximize')"
            >
              <Minimize2 v-if="props.maximized" class="size-3.5" />
              <Maximize2 v-else class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ props.maximized ? "Restore Panel" : "Maximize Panel" }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground ml-0.5"
              tabindex="0"
              @click="emit('toggleRight')"
            >
              <PanelRightFilled class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" class="flex items-center gap-2">
            <span>Hide Panel</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-right-panel')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </template>
    </TabBar>
  </TooltipProvider>
</template>
