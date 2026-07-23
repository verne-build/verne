<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { SquareTerminal, SplitSquareHorizontal, PanelRight, PanelLeft, PanelBottom, PanelTop, X, RotateCw } from "@lucide/vue";
import { ask } from "@/platform";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import {
  decrementMountedTerminalViewCount,
  incrementMountedTerminalViewCount,
} from "@/composables/useTerminal";
import { useShortcuts } from "@/composables/useShortcuts";
import { agentIconSurfaceForTheme, getAgentIconForSurface } from "@/composables/useAgentIcon";
import { useTheme } from "@/composables/useTheme";
import { collectPaneIds } from "@/lib/paneLayout";
import GridTerminal from "@/components/terminal/GridTerminal.vue";
import {
  getDroppedPaths,
  hasPathDrop,
  formatPathsForShell,
  PASTE_PATH_EVENT,
  PASTE_PATH_ENTER_EVENT,
  PASTE_PATH_LEAVE_EVENT,
} from "@/lib/dropPath";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const props = defineProps<{
  paneId: string;
  scopeId: string;
  focusedSessionId?: string;
  /** Arrangement has more than one pane → show per-pane close + focus highlight. */
  multi: boolean;
}>();

const store = useWorkspaceStore();
const rpc = useRpc();
const shortcuts = useShortcuts();
const { activeThemeName, getActiveThemeSpec } = useTheme();

function shortcutText(name: string): string {
  const keys = shortcuts.displayKeys(name);
  return keys.some((key) => key.length > 1) ? keys.join("+") : keys.join("");
}

const container = ref<HTMLElement | null>(null);
const gridRef = ref<InstanceType<typeof GridTerminal> | null>(null);
const terminalWrapper = ref<HTMLElement | null>(null);
// Exposed on the container so dictation can resolve the focused terminal's PTY
// session and inject transcribed text via sendTextToSession().
const sessionId = ref<string | null>(null);
const dropActive = ref(false);

const isActive = computed(() => props.multi && props.focusedSessionId === props.paneId);
const isExited = computed(() => store.sessionLifecycle.get(props.paneId) === "exited");

function pastePaths(paths: string[]) {
  const text = formatPathsForShell(paths);
  if (text) gridRef.value?.sendText(text);
}

// --- Native file-path drop (file-tree + OS items) ---
function onDragOver(e: DragEvent) {
  if (!hasPathDrop(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  dropActive.value = true;
}
function onDragLeave(e: DragEvent) {
  if (e.relatedTarget && terminalWrapper.value?.contains(e.relatedTarget as Node)) return;
  dropActive.value = false;
}
function onDrop(e: DragEvent) {
  dropActive.value = false;
  const paths = getDroppedPaths(e);
  if (!paths.length) return;
  e.preventDefault();
  e.stopPropagation();
  pastePaths(paths);
}

// dnd-kit (file tabs) custom-event drop path.
function onPastePathEvent(e: Event) {
  const detail = (e as CustomEvent<string | string[]>).detail;
  const paths = Array.isArray(detail) ? detail : detail ? [detail] : [];
  pastePaths(paths);
}
function onPastePathEnter() { dropActive.value = true; }
function onPastePathLeave() { dropActive.value = false; }

watch(terminalWrapper, (el, prev) => {
  prev?.removeEventListener(PASTE_PATH_EVENT, onPastePathEvent);
  prev?.removeEventListener(PASTE_PATH_ENTER_EVENT, onPastePathEnter);
  prev?.removeEventListener(PASTE_PATH_LEAVE_EVENT, onPastePathLeave);
  el?.addEventListener(PASTE_PATH_EVENT, onPastePathEvent);
  el?.addEventListener(PASTE_PATH_ENTER_EVENT, onPastePathEnter);
  el?.addEventListener(PASTE_PATH_LEAVE_EVENT, onPastePathLeave);
});

const tab = computed(() =>
  (store.terminalTabsByDirectory[props.scopeId] ?? []).find((t) => t.id === props.paneId),
);

const agentType = computed(() => {
  const runtime = store.tabRuntime.get(props.paneId);
  return runtime ? runtime.agentType : tab.value?.lastAgentType;
});

const foregroundCommand = computed(() => store.tabRuntime.get(props.paneId)?.foregroundCommand);

const panelLabel = computed(() => {
  const agent = agentType.value;
  if (agent) return agent.charAt(0).toUpperCase() + agent.slice(1);
  return foregroundCommand.value || "zsh";
});

const agentIconSurface = computed(() => {
  void activeThemeName.value;
  return agentIconSurfaceForTheme(getActiveThemeSpec().type);
});
const agentIconSrc = computed(() =>
  agentType.value ? getAgentIconForSurface(agentType.value, agentIconSurface.value) : null,
);

// Other sessions in THIS pane's scope it could split with (excludes panes
// already in the scope's arrangement). Keyed by props.scopeId, not the
// selected directory — they can differ transiently.
const otherSessions = computed(() => {
  const arr = store.arrangementFor(props.scopeId);
  const inView = new Set(arr ? collectPaneIds(arr.layout) : []);
  return store
    .sessionsList("all")
    .filter((row) => row.directory.id === props.scopeId && !inView.has(row.tab.id));
});

// tabsSessionId → ensure_tab_session is idempotent (returns the existing
// session, or respawns after a daemon restart). Only called on mount.
let mountGen = 0;
async function mountActive(opts: { force?: boolean } = {}) {
  // Lifecycle-aware: an exited session shows the overlay instead of silently
  // respawning. Explicit restart (overlay click / restart event) forces.
  if (!opts.force && store.sessionLifecycle.get(props.paneId) === "exited") return;
  const gen = ++mountGen;
  // Resolve the PTY session id; GridTerminal opens its own grid WS connection
  // (the xterm path is no longer used here).
  const sid = await rpc.request.tabsSessionId({ id: props.paneId });
  if (gen !== mountGen) return;
  if (!sid) return;
  sessionId.value = sid;
  store.markSessionRunning(props.paneId);
}

function restart() {
  void mountActive({ force: true });
}

// Sidebar Restart for an already-in-view exited session: selectSession only
// focuses, so the pane must be told to respawn explicitly.
function onRestartEvent(e: Event) {
  const detail = (e as CustomEvent<{ tabId: string }>).detail;
  if (detail?.tabId === props.paneId) restart();
}

watch(() => props.paneId, () => { void mountActive(); });

function focusPane() {
  if (store.focusedSessionId !== props.paneId) store.focusSession(props.paneId);
}

function split(direction: "h" | "v", before = false) {
  void store.splitSessionWithNew(props.paneId, direction, before);
}
function splitH() { split("h"); }
function splitV() { split("v"); }
function splitWithExisting(otherId: string) {
  store.splitSessionWithExisting(props.paneId, otherId, "h");
}

function removeFromView() {
  store.removeFromView(props.paneId);
}

function runningProcessLabel(): string {
  const a = agentType.value;
  if (a) return a.charAt(0).toUpperCase() + a.slice(1);
  return foregroundCommand.value || "a process";
}

async function closeSession() {
  const hasChild = await rpc.request.tabsHasRunningChild({ id: props.paneId }).catch(() => false);
  if (hasChild) {
    const ok = await ask("Close Session?", {
      detail: `${runningProcessLabel()} is still running. If you close the session the process will be killed.`,
      confirmLabel: "Close",
    });
    if (!ok) return;
  }
  await store.closeSession(props.paneId);
}

onMounted(() => {
  incrementMountedTerminalViewCount();
  window.addEventListener("restart-terminal-session", onRestartEvent);
  void mountActive();
});
onUnmounted(() => {
  decrementMountedTerminalViewCount();
  window.removeEventListener("restart-terminal-session", onRestartEvent);
  // GridTerminal tears down its own session/renderer on unmount. The PTY itself
  // lives in the daemon and is only closed by an explicit close
  // (store.closeSession).
});
</script>

<template>
  <div class="flex flex-col h-full min-h-0" @focusin="focusPane">
    <!-- Title bar: label + split / close actions -->
    <div
      class="flex items-center pl-4 pr-1 h-8 text-xs bg-sidebar border-b overflow-hidden shrink-0 gap-1.5"
      :class="isActive ? 'border-border text-foreground' : 'border-border text-muted-foreground'"
    >
      <img v-if="agentIconSrc" :src="agentIconSrc" class="size-3.5 shrink-0" :alt="panelLabel" />
      <SquareTerminal v-else class="size-3.5 shrink-0" />
      <span class="truncate flex-1" :class="isActive ? 'text-foreground' : ''">{{ panelLabel }}</span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button data-no-drag size="icon-xs" variant="ghost" class="text-muted-foreground" title="Split">
            <SplitSquareHorizontal class="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" size="sm">
          <DropdownMenuItem @select="split('h', false)">
            <PanelRight class="size-3.5" />
            <span>Split Right</span>
            <DropdownMenuShortcut>{{ shortcutText("split-pane-h") }}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem @select="split('h', true)"><PanelLeft class="size-3.5" /> Split Left</DropdownMenuItem>
          <DropdownMenuItem @select="split('v', false)">
            <PanelBottom class="size-3.5" />
            <span>Split Down</span>
            <DropdownMenuShortcut>{{ shortcutText("split-pane-v") }}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem @select="split('v', true)"><PanelTop class="size-3.5" /> Split Up</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger :disabled="otherSessions.length === 0">
              Split With Existing Session…
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                v-for="row in otherSessions"
                :key="row.tab.id"
                @select="splitWithExisting(row.tab.id)"
              >
                {{ store.sessionName(row.tab.id) }}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        v-if="multi"
        data-no-drag
        size="icon-xs"
        variant="ghost"
        class="text-muted-foreground"
        title="Remove From View"
        @click="removeFromView"
      >
        <X class="size-3.5" />
      </Button>
    </div>

    <ContextMenu>
      <ContextMenuTrigger as-child>
        <div
          ref="terminalWrapper"
          class="flex-1 min-h-0 relative"
          data-terminal-drop
          :data-active-terminal="!multi || focusedSessionId === paneId ? 'true' : undefined"
          @dragover.capture="onDragOver"
          @dragleave.capture="onDragLeave"
          @drop.capture="onDrop"
        >
          <div ref="container" :data-session-id="sessionId" class="absolute inset-0 overflow-hidden">
            <GridTerminal
              v-if="sessionId"
              ref="gridRef"
              :key="sessionId"
              :session-id="sessionId"
              :cwd="tab?.cwd"
              @resized="(cols, rows) => store.syncViewportSize(props.paneId, cols, rows)"
            />
          </div>
          <!-- Active-pane border: an overlay above the xterm so the right edge
               isn't hidden behind the terminal scrollbar. -->
          <div
            v-if="isActive"
            class="pointer-events-none absolute inset-0 z-30 ring-1 ring-inset ring-primary/40"
          />
          <div
            v-if="dropActive"
            class="pointer-events-none absolute inset-0 z-20 border-2 border-primary/60 bg-primary/5"
          />
          <!-- Exited overlay: PTY is gone; click to respawn. -->
          <button
            v-if="isExited"
            type="button"
            class="absolute inset-0 z-40 flex items-center justify-center bg-[var(--editor-bg)]/50 opacity-50 hover:opacity-70 transition-opacity cursor-pointer"
            @click="restart"
          >
            <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RotateCw class="size-3.5" />
              Session exited — click to restart
            </span>
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem @select="() => gridRef?.copySelection()">
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem @select="() => gridRef?.paste()">
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @select="splitH">
          Split Right
          <ContextMenuShortcut>{{ shortcutText("split-pane-h") }}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem @select="splitV">
          Split Down
          <ContextMenuShortcut>{{ shortcutText("split-pane-v") }}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem v-if="multi" @select="removeFromView">Remove From View</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" @select="closeSession">Close Session</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>
</template>
