<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { SquareTerminal, Columns2, Trash2 } from "@lucide/vue";
import { DragDropProvider } from "@dnd-kit/vue";
import SortableItem from "@/components/dnd/SortableItem.vue";
import { sortableSensors } from "@/components/dnd/sensors";
import { useWorkspaceStore } from "@/stores/workspace";
import { bottomListRows, type BottomListRow } from "@/lib/bottomList";
import { bottomSurfaceKey, groupNumber } from "@/lib/bottomPanel";
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
// Precomputed once per render, not re-scanned per row (AGENTS.md: no helpers
// called repeatedly inside v-for) — used for SortableItem's stable index.
const groupIndex = computed(() => {
  const m = new Map<string, number>();
  groupIds.value.forEach((id, i) => m.set(id, i));
  return m;
});

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
  for (const r of rows.value) {
    // A split group is "Group N" (its panes carry the command names); a solo
    // group shows its terminal. A user rename beats both.
    const split = r.kind === "group" && panesOf(r.groupId).length > 1;
    const renamed = paneTab(r.paneId)?.userRenamed;
    const n = state.value ? groupNumber(state.value, r.groupId) : undefined;
    m.set(rowKey(r), split && !renamed && n !== undefined ? `Group ${n}` : paneName(r.paneId));
  }
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
  if (state.value?.activeTabId !== r.groupId) return false;
  // A split group's focused pane already carries the highlight on its own row
  // — don't also light up the group row, or one active terminal reads as two.
  const panes = panesOf(r.groupId);
  return panes.length <= 1 || !panes.includes(store.bottomFocusedSessionId ?? "");
}

function select(r: BottomListRow) {
  store.activateBottomPanelTab(props.dirId, r.groupId);
  if (r.kind === "pane") store.focusSession(r.paneId);
}

async function closeGroup(groupId: string): Promise<void> {
  const panes = panesOf(groupId);
  if (!panes.length) return;
  if (await confirmCloseTerminals(panes, "Close Tab?")) await store.closeBottomTab(props.dirId, groupId);
}

async function close(r: BottomListRow, e?: MouseEvent) {
  e?.stopPropagation();
  if (r.kind === "pane") {
    if (await confirmCloseTerminals([r.paneId])) await store.closeBottomPane(r.paneId);
    return;
  }
  await closeGroup(r.groupId);
}

async function closeAllGroups() {
  for (const groupId of [...groupIds.value]) await closeGroup(groupId);
}

// Drops the grouping only — the PTY keeps running (VS Code: Unsplit Terminal).
function unsplitRow(r: BottomListRow) {
  store.unsplitBottomPane(r.paneId);
}

function splitRow(r: BottomListRow) {
  void store.splitSessionWithNew(r.paneId, "h");
}

// ---- rename (group rows only), mirroring the old tab pill's flow ----
const renamingId = ref<string | null>(null);
const renameInputEl = ref<HTMLInputElement | null>(null);
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
  renameInputEl.value = el;
  // Defer past reka-ui's close-focus-restoration so .select() sticks. Guard
  // re-entrancy: if a newer input mounted before this frame fires, a stale
  // rAF must not steal focus from it.
  requestAnimationFrame(() => {
    if (renameInputEl.value !== el) return;
    el.focus();
    el.select();
  });
}
function onRenameInputUnmounted() {
  renameInputEl.value = null;
}
// @blur alone misses clicks that land outside the input but don't blur it
// through the normal DOM flow (e.g. reka-ui's context menu / focus guards) —
// a capture-phase document listener is the reliable way to commit on any
// outside mousedown, mirroring the old tab pill's rename flow.
function onDocMousedown(e: MouseEvent) {
  const id = renamingId.value;
  const el = renameInputEl.value;
  if (!id || !el) return;
  const target = e.target as Node | null;
  if (target && (target === el || el.contains(target))) return;
  const row = rows.value.find((r) => r.kind === "group" && r.groupId === id);
  if (row) void finishRename(row, el.value);
}
onMounted(() => document.addEventListener("mousedown", onDocMousedown, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMousedown, true));

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
            <!-- Pane rows are never draggable — they must NOT share dnd-kit's
                 sortable registry with group rows (same id key would replace
                 the group row's registration and desync indices). Plain div. -->
            <SortableItem
              v-if="row.kind === 'group'"
              :id="row.groupId"
              :index="groupIndex.get(row.groupId) ?? -1"
              group="bottom-terminals"
              class="block"
            >
              <div
                class="group flex h-7 cursor-default select-none items-center gap-1.5 mx-1 mb-0.5 pr-1 rounded-md data-[dragging=true]:opacity-50 pl-2"
                :class="isActive(row) ? 'bg-[var(--color-tab-active-bg)] text-[var(--color-foreground)]' : 'text-[var(--color-soft-foreground)] hover:bg-[color-mix(in_oklch,var(--color-border)_25%,transparent)]'"
                @click="select(row)"
                @dblclick="startRename(row)"
              >
                <Columns2
                  v-if="(splitCounts.get(row.groupId) ?? 0) > 1"
                  class="size-3.5 shrink-0 text-[var(--color-foreground)]"
                  aria-hidden="true"
                />
                <StatusIndicator
                  v-else-if="rowState.get(rowKey(row))"
                  :state="rowState.get(rowKey(row))!"
                  class="size-3 shrink-0"
                />
                <SquareTerminal v-else class="size-3.5 shrink-0 text-[var(--color-foreground)]" aria-hidden="true" />
                <input
                  v-if="renamingId === row.groupId"
                  type="text"
                  class="min-w-0 flex-1 border-b border-primary bg-transparent text-xs text-foreground outline-none"
                  :value="renameSeed(row)"
                  @click.stop
                  @keydown.enter="finishRename(row, ($event.target as HTMLInputElement).value)"
                  @keydown.escape="cancelRename()"
                  @blur="finishRename(row, ($event.target as HTMLInputElement).value)"
                  @vue:mounted="({ el }: any) => onRenameInputMounted(el)"
                  @vue:unmounted="onRenameInputUnmounted"
                />
                <span v-else class="min-w-0 flex-1 truncate">{{ rowLabel.get(rowKey(row)) }}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  data-no-drag
                  class="hidden size-5 shrink-0 group-hover:inline-flex"
                  aria-label="Close Group"
                  @click.stop="close(row, $event)"
                >
                  <Trash2 />
                </Button>
              </div>
            </SortableItem>
            <div
              v-else
              class="group flex h-7 cursor-default select-none items-center gap-1.5 ml-4 mr-1 mb-0.5 pr-1 rounded-md pl-1.5"
              :class="isActive(row) ? 'bg-[var(--color-tab-active-bg)] text-[var(--color-foreground)]' : 'text-[var(--color-soft-foreground)] hover:bg-[color-mix(in_oklch,var(--color-border)_25%,transparent)]'"
              @click="select(row)"
            >
              <!-- └ carried by the item itself: a corner glyph inside the row,
                   not a rule spanning rows, so nothing has to line up. -->
              <span
                class="mb-1 h-2 w-2 shrink-0 rounded-bl-[3px] border-b border-l border-[color-mix(in_oklch,var(--color-soft-foreground)_70%,transparent)]"
                aria-hidden="true"
              />
              <StatusIndicator
                v-if="rowState.get(rowKey(row))"
                :state="rowState.get(rowKey(row))!"
                class="size-3 shrink-0"
              />
              <SquareTerminal v-else class="size-3.5 shrink-0 text-[var(--color-foreground)]" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ rowLabel.get(rowKey(row)) }}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                data-no-drag
                class="hidden size-5 shrink-0 group-hover:inline-flex"
                aria-label="Close Terminal"
                @click.stop="close(row, $event)"
              >
                <Trash2 />
              </Button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent @close-auto-focus.prevent>
            <ContextMenuItem v-if="row.kind === 'group'" @select="startRename(row)">Rename</ContextMenuItem>
            <ContextMenuItem @select="splitRow(row)">Split Right</ContextMenuItem>
            <ContextMenuItem v-if="row.kind === 'pane'" @select="unsplitRow(row)">
              Unsplit Terminal
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem @select="close(row)">Close</ContextMenuItem>
            <ContextMenuItem v-if="row.kind === 'group'" :disabled="groupIds.length <= 1" @select="closeAllGroups()">
              Close All
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </template>
    </div>
  </DragDropProvider>
</template>
