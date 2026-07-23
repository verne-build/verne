<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, type Ref } from "vue";
import { Columns2, Pencil, RotateCcw, SquareTerminal, Trash2 } from "@lucide/vue";
import SortableItem from "@/components/dnd/SortableItem.vue";
import StatusIndicator from "@/components/StatusIndicator.vue";
import SlotText from "@/components/SlotText.vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { ask } from "@/platform";
import { getAgentIcon } from "@/composables/useAgentIcon";
import { resolveDisplayState, stripSpinner } from "@/lib/agentStatus";
import type { DisplayState } from "@/lib/agentStatus";
import type { SessionRow } from "@/lib/sessionsView";
import { collectPaneIds, paneCount } from "@/lib/paneLayout";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const props = defineProps<{
  row: SessionRow;
  index: number;
  group: string;
  /** Worktree-scope rows indent one level deeper than root-scope rows. */
  nested?: boolean;
  /** Reordering is disabled while a filter query hides siblings. */
  dndDisabled?: boolean;
}>();

const store = useWorkspaceStore();
const rpc = useRpc();
// Focusing a session reveals its terminal, so drop out of the maximized file panel.
const fileMaximized = inject<Ref<boolean>>("fileMaximized");

const id = computed(() => props.row.tab.id);

const state = computed<DisplayState>(() => {
  const runtime = store.tabRuntime.get(id.value);
  return (
    resolveDisplayState({
      needsAcknowledgement: runtime?.needsAcknowledgement,
      agentType: runtime?.agentType,
      agentState: runtime?.agentState ?? props.row.tab.lastAgentState,
    }) ?? "unknown"
  );
});

// Match the terminal panes (raw session name, spinner glyphs stripped).
const title = computed(() => stripSpinner(store.sessionName(id.value)));
const exited = computed(() => store.sessionLifecycle.get(id.value) === "exited");
const focused = computed(
  () => id.value === store.focusedSessionId && props.row.directory.id === store.selectedDirectoryId,
);
// Part of a multi-pane arrangement in its scope → show a composition marker.
const composed = computed(() => {
  const arr = store.arrangementFor(props.row.directory.id);
  if (!arr) return false;
  return paneCount(arr.layout) > 1 && collectPaneIds(arr.layout).includes(id.value);
});
const iconSrc = computed(() => (props.row.agentType ? getAgentIcon(props.row.agentType) : null));

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

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function focus() {
  if (fileMaximized) fileMaximized.value = false;
  store.selectSession(id.value);
}

// -- inline rename (same mechanics as worktree rename in SessionsSidebar) --
const renaming = ref(false);
const renameInputEl = ref<HTMLInputElement | null>(null);

function startRename() {
  renaming.value = true;
}

async function finishRename(value: string) {
  if (!renaming.value) return;
  renaming.value = false;
  renameInputEl.value = null;
  document.removeEventListener("mousedown", onDocMousedown, true);
  const trimmed = value.trim();
  if (!trimmed || trimmed === title.value) return;
  try {
    await store.renameTab(id.value, trimmed);
  } catch (e) {
    window.alert(`Failed to rename session: ${e}`);
  }
}

function cancelRename() {
  renaming.value = false;
  renameInputEl.value = null;
  document.removeEventListener("mousedown", onDocMousedown, true);
}

function onRenameInputMounted(el: HTMLInputElement | null) {
  if (!el) return;
  renameInputEl.value = el;
  document.addEventListener("mousedown", onDocMousedown, true);
  requestAnimationFrame(() => {
    if (renameInputEl.value !== el) return;
    el.focus();
    el.select();
  });
}

function onMenuCloseAutoFocus(e: Event) {
  // Started a rename from the context menu: keep focus on the rename input.
  // Otherwise reka-ui returns focus to the trigger button, blurring the input
  // and cancelling the rename before any typing (flash-then-revert bug).
  if (renaming.value) e.preventDefault();
}

function onDocMousedown(e: MouseEvent) {
  const el = renameInputEl.value;
  if (!renaming.value || !el) return;
  const target = e.target as Node | null;
  if (target && (target === el || el.contains(target))) return;
  finishRename(el.value);
}

onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMousedown, true));

// -- close with confirm (running child processes get killed) --
function runningProcessLabel(): string {
  const runtime = store.tabRuntime.get(id.value);
  const agent = runtime?.agentType;
  if (agent) return titleCase(agent);
  return runtime?.foregroundCommand ?? "a process";
}

// Restart an exited session. selectSession only focuses when the pane is
// already in view, so also tell the mounted TerminalPane to respawn. Dispatch
// on nextTick so a newly-mounted pane (not-in-view case) has its listener up.
function restartSession() {
  store.selectSession(id.value);
  void nextTick(() =>
    window.dispatchEvent(
      new CustomEvent("restart-terminal-session", { detail: { tabId: id.value } }),
    ),
  );
}

async function closeSession() {
  const running = await rpc.request.tabsHasRunningChild({ id: id.value }).catch(() => false);
  if (running) {
    const ok = await ask("Close Session?", {
      detail: `${runningProcessLabel()} is still running. If you close the session the process will be killed.`,
      confirmLabel: "Close",
    });
    if (!ok) return;
  }
  await store.closeSession(id.value);
}
</script>

<template>
  <SortableItem :id="row.tab.id" :index="index" :group="group" :disabled="dndDisabled">
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <Button
          :as="'div'"
          :variant="focused ? 'secondary' : 'ghost'"
          size="sm"
          class="group cursor-pointer mr-1.5 h-7 items-center justify-start gap-1.5 px-2.5 py-1 text-xs font-normal data-[dragging=true]:opacity-50"
          :class="[
            nested ? 'ml-[2.375rem] w-[calc(100%-2.75rem)]' : 'ml-[1.625rem] w-[calc(100%-2rem)]',
            exited ? 'opacity-60' : '',
          ]"
          @click="focus"
          @dblclick="startRename()"
        >
          <span v-if="row.agentType" class="status-indicator-slot">
            <StatusIndicator :state="state" class="size-3" />
          </span>
          <img v-if="iconSrc" :src="iconSrc" class="size-3.5 shrink-0" :alt="row.agentType ?? ''" />
          <SquareTerminal v-else class="size-3.5 shrink-0 text-muted-foreground" />
          <input
            v-if="renaming"
            type="text"
            class="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border-b border-primary"
            :value="title"
            @click.stop
            @keydown.enter="finishRename(($event.target as HTMLInputElement).value)"
            @keydown.escape="cancelRename()"
            @blur="finishRename(($event.target as HTMLInputElement).value)"
            @vue:mounted="({ el }: any) => onRenameInputMounted(el)"
          />
          <span v-else class="min-w-0 truncate text-left text-foreground">{{ title }}</span>
          <Columns2 v-if="composed" class="size-3 shrink-0 text-muted-foreground/70" aria-label="In a split" />
          <span v-if="exited" class="ml-auto shrink-0 text-[10px] leading-none text-muted-foreground/70">exited</span>
          <SlotText
            v-else-if="row.agentType"
            :text="stateWord(state)"
            :direction="statusRollDirection(state)"
            :class="['ml-auto w-11 shrink-0 text-right text-[10px] leading-none', statusTextClass(state)]"
          />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent @close-auto-focus="onMenuCloseAutoFocus">
        <ContextMenuItem @select="startRename()">
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuItem v-if="exited" @select="restartSession()">
          <RotateCcw />
          Restart
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" @select="closeSession()">
          <Trash2 />
          Close Session
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </SortableItem>
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
