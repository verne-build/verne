<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, type Ref } from "vue";
import {
  Archive,
  ArchiveRestore,
  Columns2,
  Folder,
  GitBranch,
  Pencil,
  RotateCcw,
  SquareTerminal,
  Trash2,
} from "@lucide/vue";
import StatusIndicator from "@/components/StatusIndicator.vue";
import SlotText from "@/components/SlotText.vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { ask } from "@/platform";
import { getAgentIcon } from "@/composables/useAgentIcon";
import { useProjectIcons } from "@/composables/useProjectIcons";
import { resolveDisplayState, stripSpinner } from "@/lib/agentStatus";
import type { DisplayState } from "@/lib/agentStatus";
import type { SessionRow } from "@/lib/sessionsView";
import { collectPaneIds, paneCount } from "@/lib/paneLayout";
import { relativeTime } from "@/lib/sessionSort";
import { sessionEndAction, sessionEndLabel, shouldConfirmArchive } from "@/lib/sessionEnd";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const props = defineProps<{
  row: SessionRow;
  branch?: string;
  rootName: string;
  rootDirId: string;
  isWorktree: boolean;
  now: number;
}>();

const store = useWorkspaceStore();
const rpc = useRpc();
const { icons: projectIcons } = useProjectIcons();
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
const archived = computed(() => props.row.tab.archivedAt != null);
// Single terminating action, shared with the pane menu + ⌘W (see lib/sessionEnd).
const endAction = computed(() => sessionEndAction({ archived: archived.value, exited: exited.value }));
const focused = computed(
  () => !store.pendingPicker && id.value === store.focusedSessionId && props.row.directory.id === store.selectedDirectoryId,
);
// Part of a multi-pane arrangement in its scope → show a composition marker.
const composed = computed(() => {
  const arr = store.arrangementFor(props.row.directory.id);
  if (!arr) return false;
  return paneCount(arr.layout) > 1 && collectPaneIds(arr.layout).includes(id.value);
});
const paneTotal = computed(() => {
  const arr = store.arrangementFor(props.row.directory.id);
  return arr ? paneCount(arr.layout) : 0;
});
const iconSrc = computed(() => (props.row.agentType ? getAgentIcon(props.row.agentType) : null));
const projectIcon = computed(() => projectIcons.value[props.rootDirId] || "");
const lastActivity = computed(() => {
  const lastOutputAt = store.tabRuntime.get(id.value)?.lastOutputAt;
  const at = (lastOutputAt && lastOutputAt > 0 ? lastOutputAt : undefined)
    ?? store.sessionActivityAt.get(id.value);
  return at ? relativeTime(at, props.now) : "";
});

// Follow Agent = NOT pinned (auto re-pin follows the agent's cwd around).
const followingAgent = computed(() => !props.row.tab.scopePinnedByUser);

function toggleFollowAgent(checked: boolean) {
  // checked here means "Follow Agent" is now on → pinned = false.
  const tabId = id.value;
  const pinned = !checked;
  void rpc.request.tabSetScopePinned({ id: tabId, pinned })
    .then(() => {
      store.setTabScopePinnedLocal(tabId, pinned);
    })
    .catch(() => {});
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
  // Archived sessions have no live process to warn about — delete outright.
  if (archived.value) {
    await store.closeSession(id.value);
    return;
  }
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

// -- archive (Task 5: live action only; un-archive lands in Task 7) --
async function archiveSession() {
  if (shouldConfirmArchive(state.value)) {
    const ok = await ask("Archive Session?", {
      detail: "This stops the running agent and keeps a read-only terminal snapshot.",
      confirmLabel: "Archive",
    });
    if (!ok) return;
  }
  try {
    await store.archiveSession(id.value);
  } catch (e) {
    window.alert(`Failed to archive session: ${e}`);
  }
}

// -- un-archive (Task 7): resume the agent or spawn a fresh shell. On failure
// keep the static archived card and surface the error. --
async function unarchive(resume: boolean) {
  try {
    await store.unarchiveSession(id.value, resume);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    window.alert(`Failed to un-archive session: ${message}`);
  }
}
</script>

<template>
  <div class="mb-0.5 mx-2 w-[calc(100%-1rem)]">
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <Button
          :as="'div'"
          :variant="focused ? 'secondary' : 'ghost'"
          class="rounded-md px-2.5 py-2 w-full h-auto flex flex-col items-stretch gap-0.5 text-left"
          :class="(exited || archived) ? 'opacity-60' : ''"
          @click="focus"
          @dblclick="startRename()"
        >
          <div class="flex items-center gap-1.5 min-w-0">
            <img v-if="projectIcon" :src="projectIcon" class="size-3.5 rounded-sm shrink-0" alt="" />
            <Folder v-else class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate text-xs font-medium text-muted-foreground">{{ rootName }}</span>
            <GitBranch v-if="isWorktree" class="size-3 shrink-0 text-muted-foreground/70" />
            <span class="ml-auto shrink-0 flex items-center gap-1">
              <template v-if="archived">
                <Archive class="size-3 text-muted-foreground" />
                <span class="text-[11px] text-muted-foreground">Archived</span>
              </template>
              <template v-else-if="row.agentType && !exited">
                <StatusIndicator :state="state" class="size-3" />
                <SlotText
                  :text="stateWord(state)"
                  :direction="statusRollDirection(state)"
                  :class="['text-[11px]', statusTextClass(state)]"
                />
              </template>
              <span v-else-if="exited" class="text-[11px] text-muted-foreground">exited</span>
              <span v-else-if="lastActivity" class="text-[11px] tabular-nums text-muted-foreground">{{ lastActivity }}</span>
            </span>
          </div>
          <div class="flex items-center gap-1.5 min-w-0">
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
            <span v-else class="truncate text-xs">{{ title }}</span>
          </div>
          <div class="flex items-center gap-1.5 min-w-0">
            <span v-if="branch" class="truncate font-mono text-[11px] text-muted-foreground/80">{{ branch }}</span>
            <span class="ml-auto shrink-0 flex items-center gap-1.5">
              <span v-if="composed" class="flex items-center gap-0.5 text-muted-foreground">
                <Columns2 class="size-3" />
                <span class="text-[10px] tabular-nums">{{ paneTotal }}</span>
              </span>
              <img v-if="row.agentType && iconSrc" :src="iconSrc" class="size-3.5" alt="" />
              <SquareTerminal v-else class="size-3.5 text-muted-foreground/70" />
            </span>
          </div>
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
        <ContextMenuCheckboxItem
          v-if="!archived"
          :model-value="followingAgent"
          @update:model-value="toggleFollowAgent"
        >
          Follow Agent
        </ContextMenuCheckboxItem>
        <ContextMenuItem v-if="!exited && !archived" @select="archiveSession()">
          <Archive />
          Archive Session
        </ContextMenuItem>
        <ContextMenuItem v-if="archived && row.tab.resumeAvailable" @select="unarchive(true)">
          <ArchiveRestore />
          Resume Agent
        </ContextMenuItem>
        <!-- Archive IS the terminating action for a live session — there is no
             separate "Close Session". Delete is offered only once nothing is
             live (archived, or the PTY already exited), so a session can still
             be removed for good. Separator shares the gate so it can't trail an
             empty section. -->
        <ContextMenuSeparator v-if="endAction === 'delete'" />
        <ContextMenuItem
          v-if="endAction === 'delete'"
          variant="destructive"
          @select="closeSession()"
        >
          <Trash2 />
          {{ sessionEndLabel(endAction) }}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>
</template>
