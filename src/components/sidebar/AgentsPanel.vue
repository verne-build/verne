<script setup lang="ts">
import { computed, inject, nextTick, ref, watch, type Ref } from "vue";
import { DragDropProvider } from "@dnd-kit/vue";
import { ListFilter } from "@lucide/vue";
import SortableItem from "@/components/dnd/SortableItem.vue";
import { sortableSensors } from "@/components/dnd/sensors";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useScrollFades } from "@/composables/useScrollFades";
import { ask } from "@/platform";
import StatusIndicator from "@/components/StatusIndicator.vue";
import SlotText from "@/components/SlotText.vue";
import { getAgentIcon } from "@/composables/useAgentIcon";
import { resolveDisplayState, stripSpinner } from "@/lib/agentStatus";
import type { DisplayState } from "@/lib/agentStatus";
import type { AgentState, Tab, WorkingDirectory } from "@/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const store = useWorkspaceStore();
const rpc = useRpc();
// Focusing an agent reveals its terminal, so drop out of the maximized file panel.
const fileMaximized = inject<Ref<boolean>>("fileMaximized");
const scope = computed({
  get: () => store.agentScope,
  set: (v) => { store.agentScope = v; },
});

const items = computed(() => store.agentsList(scope.value));

// top/bottom content fades against the fixed header
const { bodyEl, atStart, atEnd, update } = useScrollFades();
watch(() => items.value.length, () => nextTick(update));

// Row enter/leave animation. Spawn → height grows + fades in; close → collapses +
// fades out, siblings glide up via FLIP. Suppressed while dragging (reorder must
// stay snappy and not fight dnd-kit transforms) and across a scope swap (a
// deliberate navigation, not a state change).
const ROW_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const ROW_ENTER_MS = 200; // spawn is a system response — snappier
const ROW_LEAVE_MS = 220; // close is a deliberate action — slightly slower
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const instant = ref(false);
function onBeforeEnter(el: Element) {
  // Drag / scope swap snap instantly; otherwise hide until the enter hook drives it.
  if (instant.value) return;
  (el as HTMLElement).style.opacity = "0";
}
function onEnter(el: Element, done: () => void) {
  const e = el as HTMLElement;
  if (instant.value) { e.style.opacity = ""; done(); return; }
  const cleanup = () => { e.style.overflow = ""; e.style.opacity = ""; e.style.transformOrigin = ""; done(); };
  // Reduced motion: keep a gentle opacity fade, drop the height/scale movement.
  if (reduceMotion.matches) {
    const anim = e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ROW_ENTER_MS, easing: ROW_EASE });
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
    return;
  }
  // Height grows 0→full so the list slides down to make room; the row scales up
  // from 0.96 + fades in so it reads as growing into place, not a shade wiping.
  const h = e.offsetHeight;
  e.style.overflow = "hidden";
  e.style.transformOrigin = "center top";
  const anim = e.animate(
    [
      { height: "0px", opacity: 0, transform: "scale(0.96)" },
      { height: `${h}px`, opacity: 1, transform: "scale(1)" },
    ],
    { duration: ROW_ENTER_MS, easing: ROW_EASE },
  );
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
}
function onLeave(el: Element, done: () => void) {
  const e = el as HTMLElement;
  if (instant.value) { done(); return; }
  // Vue pins leaving rows to position:absolute for sibling FLIP (which slides the
  // list up) — pin the width too so the row keeps its size as it shrinks out.
  e.style.width = `${e.offsetWidth}px`;
  if (reduceMotion.matches) {
    const anim = e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ROW_LEAVE_MS, easing: ROW_EASE });
    anim.onfinish = done;
    anim.oncancel = done;
    return;
  }
  e.style.overflow = "hidden";
  e.style.transformOrigin = "center top";
  const anim = e.animate(
    [
      { height: `${e.offsetHeight}px`, opacity: 1, transform: "scale(1)" },
      { height: "0px", opacity: 0, transform: "scale(0.96)" },
    ],
    { duration: ROW_LEAVE_MS, easing: ROW_EASE },
  );
  anim.onfinish = done;
  anim.oncancel = done;
}

// Scope toggle swaps the whole list — keep that instant.
watch(scope, () => {
  instant.value = true;
  nextTick(() => { instant.value = false; });
});

function state(tabId: string, fallback?: AgentState): DisplayState {
  const runtime = store.tabRuntime.get(tabId);
  return (
    resolveDisplayState({
      needsAcknowledgement: runtime?.needsAcknowledgement,
      agentType: runtime?.agentType,
      agentState: runtime?.agentState ?? fallback,
    }) ?? "unknown"
  );
}

function agentName(tabId: string, fallback?: string): string {
  return titleCase(store.tabRuntime.get(tabId)?.agentType ?? fallback ?? "unknown");
}

function agentIconSrc(tabId: string): string | null {
  const agentType = store.tabRuntime.get(tabId)?.agentType;
  return agentType ? getAgentIcon(agentType) : null;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Match the terminal tab bar (raw tabGroupName, spinner glyphs stripped).
function agentTitle(tabId: string): string {
  return stripSpinner(store.tabGroupName(tabId));
}

function primaryLabel(item: { tab: Tab; directory: WorkingDirectory }): string {
  return scope.value === "current" ? agentTitle(item.tab.id) : item.directory.name;
}

function secondaryLabel(item: { tab: Tab; directory: WorkingDirectory }): string {
  return scope.value === "current" ? item.directory.name : agentTitle(item.tab.id);
}

function stateWord(s: DisplayState): string {
  switch (s) {
    case "blocked": return "Blocked";
    case "working": return "Working";
    case "done": return "Done";
    case "idle": return "Idle";
    default: return "Unknown";
  }
}

function statusTextClass(s: DisplayState): string {
  switch (s) {
    case "blocked": return "text-amber-400";
    case "working": return "text-sky-400";
    case "done": return "text-violet-400";
    case "idle": return "text-green-400";
    default: return "text-muted-foreground";
  }
}

function statusRollDirection(s: DisplayState): "up" | "down" {
  return s === "blocked" || s === "working" ? "up" : "down";
}

function focus(tabId: string, directoryId: string) {
  if (fileMaximized) fileMaximized.value = false;
  const dir = store.directories.find((d) => d.id === directoryId) ?? null;
  store.selectDirectory(dir);
  store.setActiveTab(directoryId, tabId);
}

function runningProcessLabel(tabId: string): string {
  const runtime = store.tabRuntime.get(tabId);
  const agent = runtime?.agentType;
  if (agent) return titleCase(agent);
  return runtime?.foregroundCommand ?? "a process";
}

async function closeAgent(tabId: string) {
  const running = await rpc.request.tabsHasRunningChild({ id: tabId }).catch(() => false);
  if (running) {
    const ok = await ask("Close Tab?", {
      detail: `${runningProcessLabel(tabId)} is still running. If you close the tab the process will be killed.`,
      confirmLabel: "Close",
    });
    if (!ok) return;
  }
  await store.closeTab(tabId);
}

function tabIndex(directoryId: string, tabId: string): number {
  const tabs = store.terminalTabsByDirectory[directoryId] ?? [];
  return tabs.findIndex(t => t.id === tabId);
}

interface DragEndPayload {
  operation: { source: { id?: string; initialIndex?: number; index?: number; group?: string } | null };
  canceled: boolean;
}
function onDragStart() {
  instant.value = true;
}
function onDragEnd(e: DragEndPayload) {
  // Keep `instant` set through the reorder patch so FLIP doesn't fight dnd-kit's
  // own drop; release once the reordered DOM has settled.
  nextTick(() => { instant.value = false; });
  if (e.canceled) return;
  const src = e.operation.source;
  if (!src) return;
  const dirId = src.group;
  if (!dirId) return;
  const from = src.initialIndex ?? -1;
  const to = src.index ?? -1;
  if (from < 0 || to < 0 || from === to) return;
  const tabs = store.terminalTabsByDirectory[dirId] ?? [];
  const ids = tabs.map(t => t.id);
  if (from >= ids.length || to >= ids.length) return;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  store.reorderTabsInDirectory(dirId, ids);
}
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col">
    <div class="flex h-7 shrink-0 items-center justify-between px-3">
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground/70">Agents</div>
      <Button
        variant="secondary"
        size="xs"
        class="h-5 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
        @click="scope = scope === 'all' ? 'current' : 'all'"
      >
        <ListFilter class="size-3" />
        {{ scope === "all" ? "All" : "Workspace" }}
      </Button>
    </div>
    <div
      class="pointer-events-none absolute inset-x-0 top-7 z-10 h-4 bg-linear-to-b from-sidebar to-transparent transition-opacity"
      :class="atStart ? 'opacity-0' : 'opacity-100'"
    />
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4 bg-linear-to-t from-sidebar to-transparent transition-opacity"
      :class="atEnd ? 'opacity-0' : 'opacity-100'"
    />
    <div ref="bodyEl" class="app-scrollbar min-h-0 flex-1 overflow-y-auto pb-1" @scroll="update">
    <DragDropProvider :sensors="sortableSensors" @drag-start="onDragStart" @drag-end="onDragEnd">
    <TransitionGroup
      tag="div"
      name="agent-list"
      :class="['agent-list flex flex-col gap-0.5', { 'is-instant': instant }]"
      @before-enter="onBeforeEnter"
      @enter="onEnter"
      @leave="onLeave"
    >
    <SortableItem
      v-for="i in items"
      :id="i.tab.id"
      :index="tabIndex(i.directory.id, i.tab.id)"
      :group="i.directory.id"
      :key="i.tab.id"
    >
    <ContextMenu>
      <ContextMenuTrigger as-child>
    <Button
      :as="'div'"
      :variant="
        store.activeTabIdByDirectory[i.directory.id] === i.tab.id &&
        store.selectedDirectoryId === i.directory.id
          ? 'secondary'
          : 'ghost'
      "
      size="sm"
      class="group cursor-pointer mx-1.5 h-auto min-h-10 w-[calc(100%-0.75rem)] flex-col items-start justify-center gap-0.5 whitespace-normal px-2.5 py-1.5 text-xs font-normal data-[dragging=true]:opacity-50"
      @click="focus(i.tab.id, i.directory.id)"
    >
      <div class="flex h-4 w-full min-w-0 items-center gap-1.5 leading-none">
        <TooltipProvider :delay-duration="200">
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="status-indicator-slot">
                <StatusIndicator :state="state(i.tab.id, i.tab.lastAgentState)" class="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" class="text-xs">
              {{ stateWord(state(i.tab.id, i.tab.lastAgentState)) }}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span class="min-w-0 truncate text-left text-foreground">{{ primaryLabel(i) }}</span>
        <template v-if="scope !== 'current'">
          <span class="shrink-0 text-muted-foreground/50">&middot;</span>
          <span class="min-w-0 truncate text-left text-muted-foreground">{{ secondaryLabel(i) }}</span>
        </template>
        <img
          v-if="agentIconSrc(i.tab.id)"
          :src="agentIconSrc(i.tab.id)!"
          class="ml-auto size-3.5 shrink-0"
          :alt="agentName(i.tab.id)"
        />
      </div>
      <div class="flex h-3.5 w-full min-w-0 items-center gap-1.5 pl-[1.125rem] text-[10px] leading-none">
        <SlotText
          :text="stateWord(state(i.tab.id, i.tab.lastAgentState))"
          :direction="statusRollDirection(state(i.tab.id, i.tab.lastAgentState))"
          :class="['w-11 shrink-0', statusTextClass(state(i.tab.id, i.tab.lastAgentState))]"
        />
      </div>
    </Button>
      </ContextMenuTrigger>
      <ContextMenuContent @close-auto-focus.prevent>
        <ContextMenuItem @select="closeAgent(i.tab.id)">Close Agent</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    </SortableItem>
    </TransitionGroup>
    </DragDropProvider>
    <div
      v-if="items.length === 0"
      class="px-3 py-1 text-xs text-muted-foreground/70"
    >
      No active agents — start one in a terminal.
    </div>
    </div>
  </div>
</template>

<style scoped>
.status-indicator-slot {
  display: inline-flex;
  width: 0.75rem;
  height: 0.75rem;
  flex: 0 0 0.75rem;
  align-items: center;
  justify-content: center;
  line-height: 0;
  vertical-align: middle;
}

/* Siblings glide as a row's slot opens/closes (the entering/leaving row itself
   grows/shrinks its height + scales + fades via WAAPI). */
.agent-list-move {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* Drag and scope-swap stay instant — no FLIP fighting dnd-kit / bulk swaps. */
.agent-list.is-instant .agent-list-move {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .agent-list-move {
    transition: none;
  }
}
</style>
