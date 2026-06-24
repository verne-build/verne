<script setup lang="ts">
import { computed, inject, nextTick, watch, type Ref } from "vue";
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
function onDragEnd(e: DragEndPayload) {
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
    <DragDropProvider :sensors="sortableSensors" @drag-end="onDragEnd">
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
</style>
