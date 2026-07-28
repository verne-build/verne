<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
// Columns2 (not SplitSquareHorizontal): the latter's outline is inset to 18x14,
// so it renders visibly shorter than the 18x18 icons beside it in the title bar.
import { SquareTerminal, Columns2, PanelRight, PanelLeft, PanelBottom, PanelTop, X, Trash2, RotateCw, Play } from "@lucide/vue";
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
import { sessionEndAction, sessionEndLabel, shouldConfirmArchive } from "@/lib/sessionEnd";
import { parseBottomSurfaceKey } from "@/lib/bottomPanel";
import { terminalTitleFrom } from "@/lib/sessionTitle";
import { confirmCloseTerminals, runningProcessLabel } from "@/composables/useConfirmClose";
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
  /** Reserve the collapsed right-panel re-expand control's overlay slot. */
  reserveRightOverlay?: boolean;
  /** This is the top-left pane and the left panel is collapsed, so the title bar
   *  must clear the macOS traffic lights + the persistent toggle/search strip
   *  (App.vue anchors it at pl-[78px] + two icon-xs buttons = 128px). */
  reserveLeftOverlay?: boolean;
  /** How ⌘W / the pane menu ends this pane. Center sessions archive; bottom
   *  panel terminals are scratch and are killed outright. */
  endMode?: "archive" | "close";
  /** Bottom panel: the pane headers ARE the panel bar, so they match the bar's
   *  h-9 instead of the center's h-11.5. */
  compact?: boolean;
  /** Bottom panel splits side-by-side only, so the headers stay one row. */
  horizontalOnly?: boolean;
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
// Archived: render the frozen snapshot read-only; never spawn a PTY.
const isArchived = computed(() => tab.value?.archivedAt != null);
// Set from the archived GridTerminal: the capture only holds the final screen
// (session ended on the alt screen). No reset watch here — the archived
// GridTerminal is keyed on paneId+archivedAt and emits this on EVERY archived
// mount (false unless known partial), so a remount can't leave a stale true.
const snapshotPartial = ref(false);

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

// scopeId is a SURFACE key — for a bottom pane it isn't a directory id, so
// resolve the owning directory from the key before looking the row up.
const tab = computed(() => {
  const dirId = parseBottomSurfaceKey(props.scopeId)?.dirId ?? props.scopeId;
  return (store.terminalTabsByDirectory[dirId] ?? []).find((t) => t.id === props.paneId);
});

const agentType = computed(() => {
  const runtime = store.tabRuntime.get(props.paneId);
  return runtime ? runtime.agentType : tab.value?.lastAgentType;
});

const foregroundCommand = computed(() => store.tabRuntime.get(props.paneId)?.foregroundCommand);

// Live agent state (falls back to the persisted last state) — gates the archive
// confirm so only a mid-work session prompts.
const agentState = computed(
  () => store.tabRuntime.get(props.paneId)?.agentState ?? tab.value?.lastAgentState,
);

const panelLabel = computed(() =>
  terminalTitleFrom({
    userRenamed: tab.value?.userRenamed,
    label: tab.value?.label,
    agentType: agentType.value ?? undefined,
    foregroundCommand: foregroundCommand.value,
  }),
);

const agentIconSurface = computed(() => {
  void activeThemeName.value;
  return agentIconSurfaceForTheme(getActiveThemeSpec().type);
});
const agentIconSrc = computed(() =>
  agentType.value ? getAgentIconForSurface(agentType.value, agentIconSurface.value) : null,
);

// Other sessions in THIS pane's surface it could split with. Keyed by
// props.scopeId (a surface key), not the selected directory — they can differ
// transiently. Archived sessions are excluded: splitting one in would put a
// frozen, read-only snapshot in a pane meant for a live PTY.
const otherSessions = computed(() => store.splittableSessions(props.scopeId));

// tabsSessionId → the daemon's spawn_tab_pty is idempotent (get_session_by_agent
// returns the existing session, or it respawns after a daemon restart). Only
// called on mount.
// opts.resume swaps in tabs_resume, which respawns execing `claude --resume
// <id>` instead of the tab's own launch_command.
let mountGen = 0;
async function mountActive(opts: { force?: boolean; resume?: boolean } = {}) {
  // Archived tabs render from the stored snapshot and must NEVER spawn a PTY —
  // guard before tabsSessionId so no session is ever resolved for them.
  if (isArchived.value) {
    sessionId.value = null;
    return;
  }
  // Lifecycle-aware: an exited session shows the overlay instead of silently
  // respawning. Explicit restart/resume (overlay click / event) forces.
  if (!opts.force && store.sessionLifecycle.get(props.paneId) === "exited") return;
  const gen = ++mountGen;
  // Resolve the PTY session id; GridTerminal opens its own grid WS connection.
  let sid: string | null;
  try {
    sid = opts.resume
      ? await rpc.request.tabsResume({ id: props.paneId })
      : await rpc.request.tabsSessionId({ id: props.paneId });
  } catch (e) {
    // Resume can fail for real (stale id, agent CLI gone). Keep the overlay so
    // Restart is still reachable. A plain restart fails differently (stale cwd
    // → ENOENT, spawn slot) — don't mislabel it a resume failure.
    if (gen === mountGen)
      window.alert(
        `${opts.resume ? "Failed to resume session" : "Failed to restart session"}: ${e instanceof Error ? e.message : String(e)}`,
      );
    return;
  }
  if (gen !== mountGen) return;
  if (!sid) return;
  sessionId.value = sid;
  store.markSessionRunning(props.paneId);
}

function restart() {
  void mountActive({ force: true });
}

function resumeAgent() {
  void mountActive({ force: true, resume: true });
}

// Sidebar Restart/Resume for an already-in-view exited session: selectSession
// only focuses, so the pane must be told to respawn explicitly.
function onRestartEvent(e: Event) {
  const detail = (e as CustomEvent<{ tabId: string; resume?: boolean }>).detail;
  if (detail?.tabId !== props.paneId) return;
  if (detail.resume) resumeAgent();
  else restart();
}

watch(() => props.paneId, () => { void mountActive(); });

// Becoming archived must drop the live session id so the archived branch
// renders and no PTY lingers. Un-archiving (archived → live) attaches to the
// already-spawned PTY via idempotent tabsSessionId.
watch(isArchived, (archived) => {
  if (archived) sessionId.value = null;
  else void mountActive({ force: true });
});

// Resume the archived agent or spawn a fresh shell. On failure keep the static
// archived view and surface the error (the snapshot/row are untouched).
async function unarchive(resume: boolean) {
  try {
    await store.unarchiveSession(props.paneId, resume);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    window.alert(`Failed to un-archive session: ${message}`);
  }
}

function focusPane() {
  if (store.focusedByScope[props.scopeId] !== props.paneId) store.focusSession(props.paneId);
}

// Bottom panel splits side-by-side only — coerce here so BOTH split menus
// (the header dropdown and the terminal's own context menu) can't produce a
// second stacked bar row.
function split(direction: "h" | "v", before = false) {
  void store.splitSessionWithNew(props.paneId, props.horizontalOnly ? "h" : direction, before);
}
function splitH() { split("h"); }
function splitV() { split("v"); }
function splitWithExisting(otherId: string) {
  store.splitSessionWithExisting(props.paneId, otherId, "h");
}

// Never in close mode: a bottom terminal dropped from its arrangement has no
// sessions-sidebar row to return through, and surfaceKeyFor would then resolve
// it to the CENTER — promoting a scratch terminal into the sessions pool.
function removeFromView() {
  if (props.endMode === "close") return;
  store.removeFromView(props.paneId);
}

// Archive replaces "close" for a live session; delete only once nothing is live.
// Shared with the sidebar card + ⌘W so the three surfaces can't drift.
const endAction = computed(() =>
  sessionEndAction({ archived: isArchived.value, exited: isExited.value }),
);

async function endSession() {
  if (props.endMode === "close") {
    if (await confirmCloseTerminals([props.paneId])) await store.closeBottomPane(props.paneId);
    return;
  }
  if (endAction.value === "delete") {
    await store.closeSession(props.paneId);
    return;
  }
  if (shouldConfirmArchive(agentState.value)) {
    const ok = await ask("Archive Session?", {
      detail: `${runningProcessLabel(props.paneId)} is still running. Archiving stops it and keeps a read-only terminal snapshot.`,
      confirmLabel: "Archive",
    });
    if (!ok) return;
  }
  try {
    await store.archiveSession(props.paneId);
  } catch (e) {
    window.alert(`Failed to archive session: ${e}`);
  }
}

const endLabel = computed(() =>
  props.endMode === "close" ? "Close Terminal" : sessionEndLabel(endAction.value),
);

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
      class="drag-region flex items-center text-xs bg-sidebar border-b overflow-hidden shrink-0 gap-1.5"
      :class="[
        compact ? 'h-9' : 'h-11.5',
        isActive ? 'border-border text-foreground' : 'border-border text-muted-foreground',
        reserveRightOverlay ? 'pr-14' : 'pr-1',
        reserveLeftOverlay ? 'pl-[133px]' : 'pl-4',
      ]"
    >
      <!-- Separates the window controls + toggle/search strip (an App.vue overlay
           that floats over this bar) from this session's own identity, so the two
           groups don't read as one run of icons. -->
      <span v-if="reserveLeftOverlay" class="h-4 w-px shrink-0 bg-border mr-1" aria-hidden="true" />
      <img v-if="agentIconSrc" :src="agentIconSrc" class="size-3.5 shrink-0" :alt="panelLabel" />
      <SquareTerminal v-else class="size-3.5 shrink-0" />
      <span class="truncate flex-1 leading-none" :class="isActive ? 'text-foreground' : ''">{{ panelLabel }}</span>
      <Button
        v-if="isArchived && tab?.resumeAvailable"
        data-no-drag
        size="xs"
        variant="ghost"
        class="text-muted-foreground"
        title="Resume agent (--resume)"
        @click="unarchive(true)"
      >
        <Play class="size-3.5" />
        Resume
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button data-no-drag size="icon-xs" variant="ghost" class="text-muted-foreground" title="Split">
            <Columns2 class="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" size="sm">
          <DropdownMenuItem @select="split('h', false)">
            <PanelRight class="size-3.5" />
            <span>Split Right</span>
            <DropdownMenuShortcut>{{ shortcutText("split-pane-h") }}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem @select="split('h', true)"><PanelLeft class="size-3.5" /> Split Left</DropdownMenuItem>
          <DropdownMenuItem v-if="!horizontalOnly" @select="split('v', false)">
            <PanelBottom class="size-3.5" />
            <span>Split Down</span>
            <DropdownMenuShortcut>{{ shortcutText("split-pane-v") }}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem v-if="!horizontalOnly" @select="split('v', true)"><PanelTop class="size-3.5" /> Split Up</DropdownMenuItem>
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
      <!-- Close mode has no "remove from view": the X kills this scratch pane
           (with the running-process confirm) instead of orphaning it. -->
      <Button
        v-if="multi"
        data-no-drag
        size="icon-xs"
        variant="ghost"
        class="text-muted-foreground"
        :title="endMode === 'close' ? 'Close Terminal' : 'Remove From View'"
        @click="endMode === 'close' ? endSession() : removeFromView()"
      >
        <Trash2 v-if="endMode === 'close'" class="size-3.5" />
        <X v-else class="size-3.5" />
      </Button>
    </div>

    <!-- Archived banner: sits in flow between the panel heading and the terminal,
         so it never covers the frozen screen. The label's tooltip carries the
         capture caveat when the session ended inside a full-screen TUI — alt
         screen keeps its scroll history in the app, never in the terminal, so
         only the final screen was captured and Resume is the only way back to
         the rest. -->
    <div
      v-if="isArchived"
      class="flex items-center justify-center gap-2 h-8 shrink-0 px-2 border-b border-border bg-sidebar text-xs"
    >
      <span
        class="text-muted-foreground"
        :title="
          snapshotPartial
            ? 'This session ended inside a full-screen app that manages its own scrollback, so the terminal only ever held the final screen. Resume to get the full history back.'
            : undefined
        "
      >
        This session is archived
      </span>
      <Button
        v-if="tab?.resumeAvailable"
        data-no-drag
        size="xs"
        variant="outline"
        class="h-5.5 px-2 gap-1"
        title="Resume agent (--resume)"
        @click="unarchive(true)"
      >
        <Play class="size-3" />
        Resume Agent
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
          <!-- Archived grid is dimmed as a passive "frozen, read-only" signal.
               Applied to the grid container only — the overlays below are siblings
               so their label + resume controls stay at full contrast. -->
          <div
            ref="container"
            :data-session-id="sessionId"
            class="absolute inset-0 overflow-hidden"
            :class="isArchived ? 'opacity-70' : ''"
          >
            <GridTerminal
              v-if="isArchived"
              ref="gridRef"
              :key="`archived:${paneId}:${tab?.archivedAt}`"
              :archived-tab-id="paneId"
              :cwd="tab?.cwd"
              :auto-focus="false"
              @archived-partial="(partial: boolean) => (snapshotPartial = partial)"
            />
            <GridTerminal
              v-else-if="sessionId"
              ref="gridRef"
              :key="sessionId"
              :session-id="sessionId"
              :cwd="tab?.cwd"
              :auto-focus="!multi || focusedSessionId === paneId"
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
          <!-- Exited overlay: PTY is gone. Resume is preferred when the agent's
               session id survived; plain restart otherwise. Never for archived
               (that's the un-archive flow). -->
          <button
            v-if="isExited && !isArchived"
            type="button"
            class="absolute inset-0 z-40 flex items-center justify-center bg-[var(--editor-bg)]/50 opacity-50 hover:opacity-70 transition-opacity cursor-pointer"
            @click="tab?.resumeAvailable ? resumeAgent() : restart()"
          >
            <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <template v-if="tab?.resumeAvailable">
                <Play class="size-3.5" />
                Session exited — click to resume agent
              </template>
              <template v-else>
                <RotateCw class="size-3.5" />
                Session exited — click to restart
              </template>
            </span>
          </button>
          <!-- Corner resume affordance for archived agents, mirroring the banner
               button so it stays reachable wherever the eye is. Overlay-only so
               scroll/select/copy underneath are unaffected; offset to clear the
               horizontal scrollbar. -->
          <button
            v-if="isArchived && tab?.resumeAvailable"
            type="button"
            data-no-drag
            class="absolute bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow hover:bg-primary/90"
            title="Resume agent (--resume)"
            @click="unarchive(true)"
          >
            <Play class="size-3.5" />
            Resume Agent
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem @select="() => gridRef?.copySelection()">
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <!-- Paste + split imply a live PTY — hidden for archived snapshots. -->
        <ContextMenuItem v-if="!isArchived" @select="() => gridRef?.paste()">
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator v-if="!isArchived" />
        <ContextMenuItem v-if="!isArchived" @select="splitH">
          Split Right
          <ContextMenuShortcut>{{ shortcutText("split-pane-h") }}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem v-if="!isArchived && !horizontalOnly" @select="splitV">
          Split Down
          <ContextMenuShortcut>{{ shortcutText("split-pane-v") }}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem v-if="multi && endMode !== 'close'" @select="removeFromView">
          Remove From View
        </ContextMenuItem>
        <ContextMenuItem v-if="isExited && !isArchived && tab?.resumeAvailable" @select="resumeAgent">
          Resume Agent
        </ContextMenuItem>
        <ContextMenuItem
          v-if="endMode !== 'close' && isArchived && tab?.resumeAvailable"
          @select="unarchive(true)"
        >
          Resume Agent
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" @select="endSession">
          {{ endLabel }}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>
</template>
