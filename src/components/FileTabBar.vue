<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, reactive, watch } from "vue";
import type { FilePanelTab, FilePanelBrowserTab } from "@/types";
import type { OpenableTabKind } from "@/types";
import { X, Asterisk, Plus } from "@lucide/vue";
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
import { TAB_TYPE_ENTRIES, tabTypeEntry } from "@/lib/rightPanelTabTypes";
import { TabBar, TabBarTrigger } from "./ui/tab-bar";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const props = defineProps<{
  tabs: FilePanelTab[];
  activeId: string | null;
  isFileDirty: (path: string) => boolean;
  rootDir?: string;
}>();

const shortcuts = useShortcuts();

const emit = defineEmits<{
  select: [id: string];
  close: [id: string];
  reorder: [ids: string[]];
  openKind: [kind: OpenableTabKind];
  promote: [id: string];
}>();

function isDirty(t: FilePanelTab) {
  return t.kind === "file" && props.isFileDirty(t.filePath);
}

function closeIds(ids: string[]) {
  for (const id of ids) emit("close", id);
}

function closeOthers(id: string) {
  closeIds(props.tabs.filter(t => t.id !== id).map(t => t.id));
}

function closeSaved() {
  closeIds(props.tabs.filter(t => !isDirty(t)).map(t => t.id));
}

function closeAll() {
  closeIds(props.tabs.map(t => t.id));
}

function hasOthers(id: string) {
  return props.tabs.some(t => t.id !== id);
}

function hasSaved() {
  return props.tabs.some(t => !isDirty(t));
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

const sortableIds = computed(() => props.tabs.map((tab) => tab.id));
const renderTabs = computed(() => props.tabs.map((tab, index) => {
  const entry = tab.kind === "file" || tab.kind === "browser" ? null : tabTypeEntry(tab.kind);
  return {
    tab,
    index,
    icon: entry?.icon ?? null,
    label: tab.kind === "file" || tab.kind === "browser" ? tab.label : entry!.label,
  };
}));
const openEntries = computed(() => TAB_TYPE_ENTRIES.map((entry) => {
  const shortcut = "shortcut" in entry ? entry.shortcut : undefined;
  return {
    ...entry,
    shortcutText: shortcut && shortcuts.bindingOf(shortcut)
      ? shortcuts.displayKeys(shortcut).join("")
      : "",
  };
}));
const dirtyFileIds = computed(() =>
  props.tabs
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
  const ids = [...sortableIds.value];
  if (from >= ids.length || to >= ids.length) return;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  emit("reorder", ids);
}
</script>

<template>
  <!-- pr reserves the persistent top-right control strip (App.vue). -->
  <TabBar variant="pill" class="pl-1.5 pr-[82px] gap-0.5 bg-sidebar">
    <DragDropProvider :sensors="sortableSensors" @drag-start="onDragStart" @drag-end="onDragEnd">
      <div class="relative flex-1 min-w-0 h-11.5 flex items-stretch">
        <div
          ref="scrollEl"
          class="h-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div ref="barRowRef" class="flex items-center h-11.5 gap-0.5">
            <SortableItem
              v-for="item in renderTabs"
              :key="item.tab.id"
              :id="item.tab.id"
              :index="item.index"
              :collision-detector="tabBarCollision"
              group="right-panel-tabs"
              class="inline-flex shrink-0"
            >
              <ContextMenu>
                <ContextMenuTrigger as-child>
                  <TabBarTrigger
                    :active="activeId === item.tab.id"
                    variant="pill"
                    class="group gap-1.5 pl-1.5 pr-1.5 transition-none overflow-hidden data-[dragging=true]:opacity-50"
                    :data-tab-id="item.tab.id"
                    @click="emit('select', item.tab.id)"
                    @dblclick="item.tab.kind === 'file' && emit('promote', item.tab.id)"
                  >
                    <FileIcon v-if="item.tab.kind === 'file'" :name="item.tab.label" :size="14" />
                    <img
                      v-else-if="item.tab.kind === 'browser' && hasFavicon(item.tab)"
                      :src="item.tab.faviconUrl"
                      class="size-3.5 shrink-0 object-contain outline outline-1 outline-black/10 dark:outline-white/10"
                      alt=""
                      @error="onFaviconError(item.tab.id)"
                    />
                    <Asterisk v-else-if="item.tab.kind === 'browser'" class="size-3.5 shrink-0" />
                    <component v-else :is="item.icon" class="size-3.5 shrink-0" />
                    <span
                      class="overflow-clip text-ellipsis whitespace-nowrap max-w-[166px]"
                      :class="{ italic: item.tab.kind === 'file' && item.tab.ephemeral }"
                      :title="item.label"
                    >{{ item.label }}</span>
                    <span
                      v-if="item.tab.kind === 'file' && isFileDirty(item.tab.filePath)"
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
                      @click.stop="emit('close', item.tab.id)"
                    >
                      <X />
                    </Button>
                  </TabBarTrigger>
                </ContextMenuTrigger>
                <ContextMenuContent @close-auto-focus.prevent>
                  <ContextMenuItem @select="emit('close', item.tab.id)">Close</ContextMenuItem>
                  <ContextMenuItem :disabled="!hasOthers(item.tab.id)" @select="closeOthers(item.tab.id)">
                    Close Others
                  </ContextMenuItem>
                  <ContextMenuItem :disabled="!hasSaved()" @select="closeSaved()">
                    Close Saved
                  </ContextMenuItem>
                  <ContextMenuItem @select="closeAll()">Close All</ContextMenuItem>
                  <template v-if="item.tab.kind === 'file'">
                    <ContextMenuSeparator />
                    <ContextMenuItem @select="addToAgentTab(item.tab)">Add to Agent</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem @select="copyAbs(item.tab)">Copy Path</ContextMenuItem>
                    <ContextMenuItem @select="copyRel(item.tab)">Copy Relative Path</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem @select="revealInFinder(item.tab)">Reveal in Finder</ContextMenuItem>
                  </template>
                </ContextMenuContent>
              </ContextMenu>
            </SortableItem>
          </div>
        </div>
        <div
          v-show="fadeLeft"
          aria-hidden="true"
          class="pointer-events-none absolute top-0 bottom-px -left-0.5 w-8 bg-linear-to-r from-sidebar to-transparent z-10"
        />
        <div
          v-show="fadeRight"
          aria-hidden="true"
          class="pointer-events-none absolute top-0 bottom-px -right-0.5 w-8 bg-linear-to-l from-sidebar to-transparent z-10"
        />
      </div>
    </DragDropProvider>

    <DropdownMenu v-if="tabs.length > 0">
      <DropdownMenuTrigger as-child>
        <Button
          size="icon-xs"
          variant="ghost"
          class="mx-0.5 size-10 shrink-0 transition-none"
          title="Open Tab"
        >
          <Plus class="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          v-for="entry in openEntries"
          :key="entry.kind"
          @select="emit('openKind', entry.kind)"
        >
          <component :is="entry.icon" class="size-3.5" />
          <span>{{ entry.label }}</span>
          <DropdownMenuShortcut v-if="entry.shortcutText">
            {{ entry.shortcutText }}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </TabBar>
</template>
