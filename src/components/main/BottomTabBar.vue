<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Columns2, PanelBottom, Plus, SquareTerminal, X } from "@lucide/vue";
import { DragDropProvider } from "@dnd-kit/vue";
import SortableItem from "@/components/dnd/SortableItem.vue";
import { sortableSensors } from "@/components/dnd/sensors";
import { useWorkspaceStore } from "@/stores/workspace";
import { useShortcuts } from "@/composables/useShortcuts";
import { collectPaneIds, paneCount } from "@/lib/paneLayout";
import { bottomSurfaceKey } from "@/lib/bottomPanel";
import { resolveDisplayState, aggregateGroupState, stripSpinner } from "@/lib/agentStatus";
import type { DisplayState } from "@/lib/agentStatus";
import StatusIndicator from "@/components/StatusIndicator.vue";
import type { LayoutNode } from "@/types";
import { TabBar, TabBarTrigger } from "@/components/ui/tab-bar";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const props = defineProps<{ dirId: string; collapsed: boolean }>();
const emit = defineEmits<{ (e: "toggle-collapsed"): void }>();

const store = useWorkspaceStore();
const shortcuts = useShortcuts();

interface BottomTab {
  id: string;
  layout: LayoutNode;
}

const tabs = computed<BottomTab[]>(() => {
  const state = store.bottomPanelFor(props.dirId);
  if (!state) return [];
  const out: BottomTab[] = [];
  for (const id of state.tabs) {
    const arr = store.arrangementFor(bottomSurfaceKey(props.dirId, id));
    if (arr) out.push({ id, layout: arr.layout });
  }
  return out;
});
const activeId = computed(() => store.bottomPanelFor(props.dirId)?.activeTabId);

const renamingId = ref<string | null>(null);
const renameInputEl = ref<HTMLInputElement | null>(null);

// The pill reflects the tab's PRIMARY pane (first leaf) — a stable name that
// does NOT change as you switch the active pane within a split.
function primaryPaneId(t: BottomTab): string {
  return collectPaneIds(t.layout)[0];
}
function tabLabel(t: BottomTab): string {
  return stripSpinner(store.sessionName(primaryPaneId(t)));
}
// Rename seeds from the raw stored label, NOT the resolved auto-name — else
// accepting the rename unchanged would lock the tab to its current OSC title.
function tabRenameSeed(t: BottomTab): string {
  const paneId = primaryPaneId(t);
  const tab = (store.terminalTabsByDirectory[props.dirId] ?? []).find((x) => x.id === paneId);
  return tab?.label ?? "";
}
function tabSplitCount(t: BottomTab): number {
  return paneCount(t.layout);
}

// Agent status of a pane (null = not an agent tab).
function paneAgentState(paneId: string): DisplayState | null {
  const rt = store.tabRuntime.get(paneId);
  const tab = (store.terminalTabsByDirectory[props.dirId] ?? []).find((x) => x.id === paneId);
  return resolveDisplayState({
    needsAcknowledgement: rt?.needsAcknowledgement,
    agentType: rt?.agentType ?? tab?.lastAgentType,
    agentState: rt?.agentState ?? tab?.lastAgentState,
    requireAgentType: true,
  });
}
const tabAgentState = computed(() => {
  const m = new Map<string, DisplayState | null>();
  for (const t of tabs.value)
    m.set(t.id, aggregateGroupState(collectPaneIds(t.layout).map(paneAgentState)));
  return m;
});

async function newTab() {
  try {
    await store.createBottomTerminal(props.dirId);
  } catch (e) {
    console.error("[BottomTabBar] createBottomTerminal failed:", e);
    window.alert(`Failed to create terminal: ${e}`);
  }
}

// Clicking a tab always opens the panel (spec: collapsed bar is the affordance).
function focus(id: string) {
  store.activateBottomPanelTab(props.dirId, id);
}

async function close(id: string, e?: MouseEvent) {
  e?.stopPropagation();
  await store.closeBottomTab(props.dirId, id);
}

async function closeAll() {
  for (const t of [...tabs.value]) await store.closeBottomTab(props.dirId, t.id);
}

function startRename(id: string) {
  renamingId.value = id;
}

async function finishRename(id: string, value: string) {
  if (renamingId.value !== id) return;
  renamingId.value = null;
  dropFocus();
  const label = value.trim();
  if (!label) return;
  const t = tabs.value.find((x) => x.id === id);
  if (!t) return;
  const paneId = primaryPaneId(t);
  const tab = (store.terminalTabsByDirectory[props.dirId] ?? []).find((x) => x.id === paneId);
  if (!tab || tab.label === label) return;
  try {
    await store.renameTab(paneId, label);
  } catch (e) {
    console.error("[BottomTabBar] renameTab failed:", e);
  }
}

function cancelRename() {
  renamingId.value = null;
  dropFocus();
}

function dropFocus() {
  (document.activeElement as HTMLElement | null)?.blur?.();
}

function onRenameInputMounted(el: HTMLInputElement | null) {
  if (!el) return;
  renameInputEl.value = el;
  // Defer past reka-ui's close-focus-restoration so .select() sticks.
  requestAnimationFrame(() => {
    if (renameInputEl.value !== el) return;
    el.focus();
    el.select();
  });
}

function onRenameInputUnmounted() {
  renameInputEl.value = null;
}

function onDocMousedown(e: MouseEvent) {
  const id = renamingId.value;
  const el = renameInputEl.value;
  if (!id || !el) return;
  const target = e.target as Node | null;
  if (target && (target === el || el.contains(target))) return;
  finishRename(id, el.value);
}

onMounted(() => {
  document.addEventListener("mousedown", onDocMousedown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocMousedown, true);
});

const scrollEl = ref<HTMLElement | null>(null);
const fadeLeft = ref(false);
const fadeRight = ref(false);
let resizeObs: ResizeObserver | null = null;
let mutationObs: MutationObserver | null = null;
let fadeFrame = 0;

function updateFades() {
  const el = scrollEl.value;
  if (!el) return;
  fadeLeft.value = el.scrollLeft > 0;
  fadeRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

async function scheduleUpdateFades() {
  await nextTick();
  if (fadeFrame) cancelAnimationFrame(fadeFrame);
  fadeFrame = requestAnimationFrame(() => {
    fadeFrame = 0;
    updateFades();
  });
}

onMounted(async () => {
  await nextTick();
  const el = scrollEl.value;
  if (!el) return;
  el.addEventListener("scroll", updateFades, { passive: true });
  resizeObs = new ResizeObserver(scheduleUpdateFades);
  resizeObs.observe(el);
  const inner = el.firstElementChild as HTMLElement | null;
  if (inner) {
    resizeObs.observe(inner);
    mutationObs = new MutationObserver(scheduleUpdateFades);
    mutationObs.observe(inner, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }
  void scheduleUpdateFades();
});

onBeforeUnmount(() => {
  scrollEl.value?.removeEventListener("scroll", updateFades);
  resizeObs?.disconnect();
  resizeObs = null;
  mutationObs?.disconnect();
  mutationObs = null;
  if (fadeFrame) cancelAnimationFrame(fadeFrame);
  fadeFrame = 0;
});

const FADE_PX = 32;
async function scrollActiveIntoView(id: string | undefined) {
  const el = scrollEl.value;
  if (!id || !el) return;
  await nextTick();
  const tabEl = el.querySelector(`[data-tab-id="${CSS.escape(id)}"]`) as HTMLElement | null;
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
  void scheduleUpdateFades();
}

watch(activeId, scrollActiveIntoView);
watch(
  () => tabs.value.map((t) => `${t.id}:${tabLabel(t)}:${tabSplitCount(t)}`).join("|"),
  () => void scheduleUpdateFades(),
);

interface DragEndPayload {
  operation: { source: { id?: string; initialIndex?: number; index?: number } | null };
  canceled: boolean;
}
function onDragEnd(e: DragEndPayload) {
  if (e.canceled) return;
  const src = e.operation.source;
  if (!src) return;
  const from = src.initialIndex ?? -1;
  const to = src.index ?? -1;
  store.reorderBottomPanelTabs(props.dirId, from, to);
}
</script>

<template>
  <TooltipProvider :delay-duration="250">
  <TabBar variant="pill" class="px-1.5 gap-0.5 bg-sidebar">
    <DragDropProvider :sensors="sortableSensors" @drag-end="onDragEnd">
    <div class="relative flex-1 min-w-0 h-9 flex items-stretch">
      <div
        ref="scrollEl"
        class="h-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
      <div class="flex items-center h-9 gap-0.5">
      <SortableItem
        v-for="(t, i) in tabs"
        :id="t.id"
        :index="i"
        :key="t.id"
        group="terminal-tabs"
        class="inline-flex"
      >
      <ContextMenu>
        <ContextMenuTrigger as-child>
          <TabBarTrigger
            :active="t.id === activeId"
            variant="pill"
            class="group gap-1.5 pl-1.5 pr-1.5 min-w-20 max-w-48 overflow-hidden transition-none data-[dragging=true]:opacity-50"
            :data-tab-id="t.id"
            @click="focus(t.id)"
            @dblclick="startRename(t.id)"
          >
            <Columns2 v-if="tabSplitCount(t) > 1" class="size-3.5 shrink-0" aria-hidden="true" />
            <StatusIndicator
              v-else-if="tabAgentState.get(t.id)"
              :state="tabAgentState.get(t.id)!"
              class="size-3 shrink-0"
            />
            <SquareTerminal v-else class="size-3.5 shrink-0" aria-hidden="true" />
            <input
              v-if="renamingId === t.id"
              type="text"
              class="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border-b border-primary"
              :value="tabRenameSeed(t)"
              @click.stop
              @keydown.enter="finishRename(t.id, ($event.target as HTMLInputElement).value)"
              @keydown.escape="cancelRename()"
              @blur="finishRename(t.id, ($event.target as HTMLInputElement).value)"
              @vue:mounted="({ el }: any) => onRenameInputMounted(el)"
              @vue:unmounted="onRenameInputUnmounted"
            />
            <template v-else>
              <span class="min-w-0 truncate">{{ tabLabel(t) }}</span>
              <span
                v-if="tabSplitCount(t) > 1"
                class="shrink-0 text-[10px] tabular-nums text-muted-foreground"
              >{{ tabSplitCount(t) }}</span>
              <span
                class="pointer-events-none hidden group-hover:block absolute right-0 top-0 bottom-0 w-12 bg-linear-to-r from-transparent via-tab-active-bg to-tab-active-bg"
              />
              <Button
                size="icon-xs"
                variant="ghost"
                data-no-drag
                class="size-5 hidden group-hover:inline-flex absolute right-1 top-1/2 z-10 -translate-y-1/2 transition-none"
                tabindex="0"
                @click.stop="close(t.id, $event)"
              >
                <X />
              </Button>
            </template>
          </TabBarTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent @close-auto-focus.prevent>
          <ContextMenuItem @select="startRename(t.id)">Rename</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="close(t.id)">Close</ContextMenuItem>
          <ContextMenuItem :disabled="tabs.length <= 1" @select="closeAll()">
            Close All
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      </SortableItem>
      </div>
      </div>
      <div
        v-show="fadeLeft"
        aria-hidden="true"
        class="pointer-events-none absolute top-0 bottom-px left-0 w-8 bg-linear-to-r from-sidebar to-transparent z-10"
      />
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
            type="button"
            size="icon-xs"
            variant="ghost"
            class="text-muted-foreground ml-3"
            aria-label="New Terminal"
            @click="newTab()"
          >
            <Plus class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" class="flex items-center gap-2">
          <span>New Terminal</span>
          <KbdGroup>
            <Kbd v-for="(key, i) in shortcuts.displayKeys('new-terminal')" :key="i">{{ key }}</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            class="text-muted-foreground"
            :aria-label="collapsed ? 'Expand terminal panel' : 'Collapse terminal panel'"
            @click="emit('toggle-collapsed')"
          >
            <PanelBottom class="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" class="flex items-center gap-2">
          <span>{{ collapsed ? "Expand Panel" : "Collapse Panel" }}</span>
          <KbdGroup>
            <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-bottom-panel')" :key="i">{{ key }}</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
    </template>
  </TabBar>
  </TooltipProvider>
</template>
