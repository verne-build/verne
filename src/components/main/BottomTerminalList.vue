<script setup lang="ts">
import { computed, ref } from "vue";
import { SquareTerminal, Columns2, X } from "@lucide/vue";
import { DragDropProvider } from "@dnd-kit/vue";
import SortableItem from "@/components/dnd/SortableItem.vue";
import { sortableSensors } from "@/components/dnd/sensors";
import { useWorkspaceStore } from "@/stores/workspace";
import { bottomListRows, type BottomListRow } from "@/lib/bottomList";
import { bottomSurfaceKey } from "@/lib/bottomPanel";
import { collectPaneIds } from "@/lib/paneLayout";
import { terminalTitleFrom } from "@/lib/sessionTitle";
import { resolveDisplayState, aggregateGroupState, stripSpinner } from "@/lib/agentStatus";
import type { DisplayState } from "@/lib/agentStatus";
import { confirmCloseTerminals } from "@/composables/useConfirmClose";
import StatusIndicator from "@/components/StatusIndicator.vue";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const props = defineProps<{ dirId: string }>();
const store = useWorkspaceStore();

const state = computed(() => store.bottomPanelFor(props.dirId));
const groupIds = computed(() => state.value?.tabs ?? []);
const rows = computed(() =>
  bottomListRows(groupIds.value, (id) => store.arrangementFor(bottomSurfaceKey(props.dirId, id))?.layout ?? null),
);

function paneTab(paneId: string) {
  return (store.terminalTabsByDirectory[props.dirId] ?? []).find((t) => t.id === paneId);
}
function paneName(paneId: string): string {
  const rt = store.tabRuntime.get(paneId);
  const tab = paneTab(paneId);
  return stripSpinner(
    terminalTitleFrom({
      userRenamed: tab?.userRenamed,
      label: tab?.label,
      agentType: rt?.agentType ?? tab?.lastAgentType ?? undefined,
      foregroundCommand: rt?.foregroundCommand,
    }),
  );
}
function panesOf(groupId: string): string[] {
  const arr = store.arrangementFor(bottomSurfaceKey(props.dirId, groupId));
  return arr ? collectPaneIds(arr.layout) : [];
}
function paneAgentState(paneId: string): DisplayState | null {
  const rt = store.tabRuntime.get(paneId);
  const tab = paneTab(paneId);
  return resolveDisplayState({
    needsAcknowledgement: rt?.needsAcknowledgement,
    agentType: rt?.agentType ?? tab?.lastAgentType,
    agentState: rt?.agentState ?? tab?.lastAgentState,
    requireAgentType: true,
  });
}
// Group rows aggregate their panes' state; pane rows show their own.
const rowState = computed(() => {
  const m = new Map<string, DisplayState | null>();
  for (const r of rows.value)
    m.set(
      rowKey(r),
      r.kind === "group" ? aggregateGroupState(panesOf(r.groupId).map(paneAgentState)) : paneAgentState(r.paneId),
    );
  return m;
});
const rowLabel = computed(() => {
  const m = new Map<string, string>();
  for (const r of rows.value) m.set(rowKey(r), paneName(r.paneId));
  return m;
});
const splitCounts = computed(() => {
  const m = new Map<string, number>();
  for (const id of groupIds.value) m.set(id, panesOf(id).length);
  return m;
});

function rowKey(r: BottomListRow): string {
  return `${r.kind}:${r.groupId}:${r.paneId}`;
}
function isActive(r: BottomListRow): boolean {
  if (r.kind === "pane") return store.bottomFocusedSessionId === r.paneId;
  return state.value?.activeTabId === r.groupId;
}

function select(r: BottomListRow) {
  store.activateBottomPanelTab(props.dirId, r.groupId);
  if (r.kind === "pane") store.focusSession(r.paneId);
}

async function close(r: BottomListRow, e?: MouseEvent) {
  e?.stopPropagation();
  if (r.kind === "pane") {
    if (await confirmCloseTerminals([r.paneId])) await store.closeBottomPane(r.paneId);
    return;
  }
  const panes = panesOf(r.groupId);
  if (!panes.length) return;
  if (await confirmCloseTerminals(panes)) await store.closeBottomTab(props.dirId, r.groupId);
}

function splitRow(r: BottomListRow) {
  void store.splitSessionWithNew(r.paneId, "h");
}

// ---- rename (group rows only), mirroring the old tab pill's flow ----
const renamingId = ref<string | null>(null);
function renameSeed(r: BottomListRow): string {
  return paneTab(r.paneId)?.label ?? "";
}
function startRename(r: BottomListRow) {
  if (r.kind === "group") renamingId.value = r.groupId;
}
function cancelRename() {
  renamingId.value = null;
}
async function finishRename(r: BottomListRow, value: string) {
  if (renamingId.value !== r.groupId) return;
  renamingId.value = null;
  const label = value.trim();
  if (!label) return;
  const tab = paneTab(r.paneId);
  if (!tab || tab.label === label) return;
  try {
    await store.renameTab(r.paneId, label);
  } catch (e) {
    console.error("[BottomTerminalList] renameTab failed:", e);
  }
}
function onRenameInputMounted(el: HTMLInputElement | null) {
  if (!el) return;
  // Defer past reka-ui's close-focus-restoration so .select() sticks.
  requestAnimationFrame(() => {
    el.focus();
    el.select();
  });
}

// ---- drag reorder (group rows only) ----
interface DragEndPayload {
  operation: { source: { id?: string; initialIndex?: number; index?: number } | null };
  canceled: boolean;
}
function onDragEnd(e: DragEndPayload) {
  if (e.canceled) return;
  const src = e.operation.source;
  if (!src) return;
  store.reorderBottomPanelTabs(props.dirId, src.initialIndex ?? -1, src.index ?? -1);
}
</script>

<template>
  <DragDropProvider :sensors="sortableSensors" @drag-end="onDragEnd">
    <div class="h-full overflow-y-auto py-1 text-xs">
      <template v-for="row in rows" :key="rowKey(row)">
        <ContextMenu>
          <ContextMenuTrigger as-child>
            <SortableItem
              :id="row.groupId"
              :index="groupIds.indexOf(row.groupId)"
              :disabled="row.kind === 'pane'"
              group="bottom-terminals"
              class="block"
            >
              <div
                class="group flex h-7 cursor-default items-center gap-1.5 pr-1 data-[dragging=true]:opacity-50"
                :class="[
                  row.depth ? 'pl-6' : 'pl-2',
                  isActive(row) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                ]"
                @click="select(row)"
                @dblclick="startRename(row)"
              >
                <Columns2
                  v-if="row.kind === 'group' && (splitCounts.get(row.groupId) ?? 0) > 1"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <StatusIndicator
                  v-else-if="rowState.get(rowKey(row))"
                  :state="rowState.get(rowKey(row))!"
                  class="size-3 shrink-0"
                />
                <SquareTerminal v-else class="size-3.5 shrink-0" aria-hidden="true" />
                <input
                  v-if="row.kind === 'group' && renamingId === row.groupId"
                  type="text"
                  class="min-w-0 flex-1 border-b border-primary bg-transparent text-xs text-foreground outline-none"
                  :value="renameSeed(row)"
                  @click.stop
                  @keydown.enter="finishRename(row, ($event.target as HTMLInputElement).value)"
                  @keydown.escape="cancelRename()"
                  @blur="finishRename(row, ($event.target as HTMLInputElement).value)"
                  @vue:mounted="({ el }: any) => onRenameInputMounted(el)"
                />
                <span v-else class="min-w-0 flex-1 truncate">{{ rowLabel.get(rowKey(row)) }}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  data-no-drag
                  class="hidden size-5 shrink-0 group-hover:inline-flex"
                  :aria-label="row.kind === 'pane' ? 'Close Terminal' : 'Close Group'"
                  @click.stop="close(row, $event)"
                >
                  <X />
                </Button>
              </div>
            </SortableItem>
          </ContextMenuTrigger>
          <ContextMenuContent @close-auto-focus.prevent>
            <ContextMenuItem v-if="row.kind === 'group'" @select="startRename(row)">Rename</ContextMenuItem>
            <ContextMenuItem @select="splitRow(row)">Split Right</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem @select="close(row)">Close</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </template>
    </div>
  </DragDropProvider>
</template>
