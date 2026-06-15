<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { Columns2, PanelRight, Plus, SquareTerminal, X } from "@lucide/vue";
import { ask } from "@/platform";
import { DragDropProvider } from "@dnd-kit/vue";
import SortableItem from "@/components/dnd/SortableItem.vue";
import { sortableSensors } from "@/components/dnd/sensors";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useShortcuts } from "@/composables/useShortcuts";
import { firstLeaf, collectPaneIds, paneCount } from "@/lib/paneLayout";
import { resolveDisplayState, aggregateGroupState, stripSpinner } from "@/lib/agentStatus";
import type { DisplayState } from "@/lib/agentStatus";
import StatusIndicator from "@/components/StatusIndicator.vue";
import type { PaneGroup } from "@/stores/workspace";
import type { AgentState } from "@/types";
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

const store = useWorkspaceStore();
const rpc = useRpc();
const shortcuts = useShortcuts();
const rightCollapsed = inject<Ref<boolean>>("rightCollapsed");
function expandRight() {
  if (rightCollapsed) rightCollapsed.value = false;
}
const leftCollapsed = inject<Ref<boolean>>("leftCollapsed");

const dirId = computed(() => store.selectedDirectoryId);
// Each pill is a GROUP (1 pane = a normal tab; 2+ panes = a split).
const groups = computed(() =>
  dirId.value ? store.tabGroupsByDirectory[dirId.value] ?? [] : [],
);
const activeId = computed(() =>
  dirId.value ? store.activeGroupIdByDirectory[dirId.value] : undefined,
);

const renamingId = ref<string | null>(null);
const renameInputEl = ref<HTMLInputElement | null>(null);

// The pill reflects the group's PRIMARY pane (first leaf) — a stable name that
// does NOT change as you switch the active pane within a split. Per-pane
// identity lives in the pane title bars + the Agents panel.
function groupPrimaryPaneId(g: PaneGroup): string {
  return firstLeaf(g.layout);
}
function groupLabel(g: PaneGroup): string {
  // Single source of truth for the precedence chain (user → OSC → process).
  // Strip the leading animated spinner glyphs agents prepend to their OSC title.
  return stripSpinner(store.tabGroupName(groupPrimaryPaneId(g)));
}
// Rename seeds from the raw stored label, NOT the resolved auto-name — else
// accepting the rename unchanged would lock the tab to its current OSC title.
function groupRenameSeed(g: PaneGroup): string {
  const paneId = groupPrimaryPaneId(g);
  const tab = (store.terminalTabsByDirectory[dirId.value ?? ""] ?? []).find((t) => t.id === paneId);
  return tab?.label ?? "";
}
function groupSplitCount(g: PaneGroup): number {
  return paneCount(g.layout);
}

// Agent status of a pane (null = not an agent tab).
function paneAgentState(paneId: string): DisplayState | null {
  const rt = store.tabRuntime.get(paneId);
  const tab = (store.terminalTabsByDirectory[dirId.value ?? ""] ?? []).find((t) => t.id === paneId);
  return resolveDisplayState({
    needsAcknowledgement: rt?.needsAcknowledgement,
    agentType: rt?.agentType ?? tab?.lastAgentType,
    agentState: rt?.agentState ?? tab?.lastAgentState,
    requireAgentType: true,
  });
}
const groupAgentState = computed(() => {
  const m = new Map<string, DisplayState | null>();
  for (const g of groups.value) {
    const states = collectPaneIds(g.layout).map(paneAgentState);
    m.set(g.id, aggregateGroupState(states));
  }
  return m;
});

async function newTab() {
  if (!dirId.value) return;
  try {
    await store.createTab({ directoryId: dirId.value });
  } catch (e) {
    console.error("[TabBar] createTab failed:", e);
    window.alert(`Failed to create tab: ${e}`);
  }
}

function focus(id: string) {
  if (!dirId.value) return;
  store.setActiveGroup(dirId.value, id);
}

function runningProcessLabel(id: string): string {
  const runtime = store.tabRuntime.get(id);
  const agent = runtime?.agentType;
  if (agent) return agent.charAt(0).toUpperCase() + agent.slice(1);
  const cmd = runtime?.foregroundCommand;
  if (cmd) return cmd;
  return "a process";
}

// True if any pane in the group has a running child process.
async function groupRunningPanes(g: PaneGroup): Promise<string[]> {
  const panes = collectPaneIds(g.layout);
  try {
    const flags = await Promise.all(
      panes.map((id) =>
        rpc.request.tabsHasRunningChild({ id }).then((b) => [id, b] as const).catch(() => [id, false] as const),
      ),
    );
    return flags.filter(([, b]) => b).map(([id]) => id);
  } catch {
    return [];
  }
}

async function confirmCloseIfRunning(g: PaneGroup): Promise<boolean> {
  const running = await groupRunningPanes(g);
  if (running.length === 0) return true;
  const names = running.map(runningProcessLabel);
  const summary = names.length === 1 ? `${names[0]} is running.` : `${names.join(", ")} are running.`;
  return await ask(`${summary} Close anyway?`, { title: "Close tab", kind: "warning" });
}

async function close(id: string, e?: MouseEvent) {
  e?.stopPropagation();
  const g = groups.value.find((x) => x.id === id);
  if (!g) return;
  if (!(await confirmCloseIfRunning(g))) return;
  await store.closeGroup(id);
}

async function closeAll() {
  const list = [...groups.value];
  if (list.length === 0) return;
  for (const g of list) {
    if (!(await confirmCloseIfRunning(g))) continue;
    await store.closeGroup(g.id);
  }
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
  const g = groups.value.find((x) => x.id === id);
  if (!g) return;
  const paneId = groupPrimaryPaneId(g);
  const tab = (store.terminalTabsByDirectory[dirId.value ?? ""] ?? []).find((t) => t.id === paneId);
  if (!tab || tab.label === label) return;
  try {
    await store.renameTab(paneId, label);
  } catch (e) {
    console.error("[TabBar] renameTab failed:", e);
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

function onCloseActiveTab() {
  if (activeId.value) void close(activeId.value);
}

onMounted(() => {
  document.addEventListener("mousedown", onDocMousedown, true);
  window.addEventListener("close-active-terminal-tab", onCloseActiveTab);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocMousedown, true);
  window.removeEventListener("close-active-terminal-tab", onCloseActiveTab);
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
  () => groups.value.map((g) => `${g.id}:${groupLabel(g)}:${groupSplitCount(g)}`).join("|"),
  () => void scheduleUpdateFades(),
);

interface DragEndPayload {
  operation: { source: { id?: string; initialIndex?: number; index?: number } | null };
  canceled: boolean;
}
function onDragEnd(e: DragEndPayload) {
  if (e.canceled || !dirId.value) return;
  const src = e.operation.source;
  if (!src) return;
  const from = src.initialIndex ?? -1;
  const to = src.index ?? -1;
  if (from < 0 || to < 0 || from === to) return;
  const ids = groups.value.map(g => g.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  store.reorderGroupsInDirectory(dirId.value, ids);
}
</script>

<template>
  <TooltipProvider :delay-duration="250">
  <TabBar variant="pill" class="px-1.5 gap-0.5 bg-sidebar">
    <!-- Clearance for the macOS traffic lights + the persistent toggle/search
         overlay (rendered in App.vue) when the left panel is collapsed. -->
    <div
      v-if="leftCollapsed"
      class="shrink-0 w-[128px] h-11.5"
    />
    <DragDropProvider :sensors="sortableSensors" @drag-end="onDragEnd">
    <div class="relative flex-1 min-w-0 h-11.5 flex items-stretch">
      <div
        ref="scrollEl"
        class="h-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
      <div class="flex items-center h-11.5 gap-0.5">
      <SortableItem
        v-for="(g, i) in groups"
        :id="g.id"
        :index="i"
        :key="g.id"
        group="terminal-tabs"
        class="inline-flex"
      >
      <ContextMenu>
        <ContextMenuTrigger as-child>
          <TabBarTrigger
            :active="g.id === activeId"
            variant="pill"
            class="group gap-1.5 pl-1.5 pr-1.5 min-w-20 max-w-48 overflow-hidden transition-none data-[dragging=true]:opacity-50"
            :data-tab-id="g.id"
            @click="focus(g.id)"
            @dblclick="startRename(g.id)"
          >
            <Columns2 v-if="groupSplitCount(g) > 1" class="size-3.5 shrink-0" aria-hidden="true" />
            <StatusIndicator
              v-else-if="groupAgentState.get(g.id)"
              :state="groupAgentState.get(g.id)!"
              class="size-3 shrink-0"
            />
            <SquareTerminal v-else class="size-3.5 shrink-0" aria-hidden="true" />
            <input
              v-if="renamingId === g.id"
              type="text"
              class="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border-b border-primary"
              :value="groupRenameSeed(g)"
              @click.stop
              @keydown.enter="finishRename(g.id, ($event.target as HTMLInputElement).value)"
              @keydown.escape="cancelRename()"
              @blur="finishRename(g.id, ($event.target as HTMLInputElement).value)"
              @vue:mounted="({ el }: any) => onRenameInputMounted(el)"
              @vue:unmounted="onRenameInputUnmounted"
            />
            <template v-else>
              <span class="min-w-0 truncate">{{ groupLabel(g) }}</span>
              <span
                v-if="groupSplitCount(g) > 1"
                class="shrink-0 text-[10px] tabular-nums text-muted-foreground"
              >{{ groupSplitCount(g) }}</span>
              <span
                class="pointer-events-none hidden group-hover:block absolute right-0 top-0 bottom-0 w-12 bg-linear-to-r from-transparent via-tab-active-bg to-tab-active-bg"
              />
              <Button
                size="icon-xs"
                variant="ghost"
                data-no-drag
                class="size-5 hidden group-hover:inline-flex absolute right-1 top-1/2 z-10 -translate-y-1/2 transition-none"
                tabindex="0"
                @click.stop="close(g.id, $event)"
              >
                <X />
              </Button>
            </template>
          </TabBarTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent @close-auto-focus.prevent>
          <ContextMenuItem @select="startRename(g.id)">Rename</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="close(g.id)">Close</ContextMenuItem>
          <ContextMenuItem :disabled="groups.length <= 1" @select="closeAll()">
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
      <Tooltip v-if="dirId">
        <TooltipTrigger as-child>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            class="text-muted-foreground ml-3"
            aria-label="New terminal tab"
            @click="newTab()"
          >
            <Plus class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" class="flex items-center gap-2">
          <span>New Terminal</span>
          <KbdGroup>
            <Kbd v-for="(key, i) in shortcuts.displayKeys('new-terminal')" :key="i">{{ key }}</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      <Tooltip v-if="dirId && rightCollapsed">
        <TooltipTrigger as-child>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            class="text-muted-foreground"
            aria-label="Show right sidebar"
            @click="expandRight"
          >
            <PanelRight class="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" class="flex items-center gap-2">
          <span>Show Panel</span>
          <KbdGroup>
            <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-right-panel')" :key="i">{{ key }}</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
    </template>
  </TabBar>
  </TooltipProvider>
</template>
