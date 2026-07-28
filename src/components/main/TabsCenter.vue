<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, type Ref } from "vue";
import { Folder, PanelRight, PanelBottom } from "@lucide/vue";
import PanelBottomFilled from "@/components/icons/PanelBottomFilled.vue";
import { ask } from "@/platform";
import { sessionEndAction, shouldConfirmArchive } from "@/lib/sessionEnd";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useShortcuts } from "@/composables/useShortcuts";
import { paneCount } from "@/lib/paneLayout";
import { firstRunView } from "@/lib/firstRunView";
import NewSessionPicker from "./NewSessionPicker.vue";
import SplitLayout from "./SplitLayout.vue";
import WelcomeHero from "./WelcomeHero.vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

const store = useWorkspaceStore();
const rpc = useRpc();
const shortcuts = useShortcuts();

const rightCollapsed = inject<Ref<boolean>>("rightCollapsed");
const leftCollapsed = inject<Ref<boolean>>("leftCollapsed");
function expandRight() {
  if (rightCollapsed) rightCollapsed.value = false;
}

const dirId = computed(() => store.selectedDirectoryId);
const showRightOverlay = computed(() => !!dirId.value && !!rightCollapsed?.value);
const arrangement = computed(() =>
  dirId.value ? store.arrangementFor(dirId.value) : null,
);
const pickerDirectoryName = computed(() => {
  const id = store.pendingPicker?.dirId;
  return store.directories.find((directory) => directory.id === id)?.name ?? "Workspace";
});

const bottomPanelOpen = computed(() => {
  const state = dirId.value ? store.bottomPanelFor(dirId.value) : null;
  return !!state?.tabs.length && !state.collapsed;
});

function toggleBottomPanel() {
  window.dispatchEvent(new CustomEvent("menu-action", { detail: { action: "toggleBottomPanel" } }));
}

const welcome = computed(() =>
  firstRunView({
    directoriesLoaded: store.directoriesLoaded,
    directoryCount: store.directories.length,
    hasSelection: !!store.selectedDirectoryId,
    welcomeSeen: store.welcomeSeen,
  }),
);

// Archive replaces "close" for a live session — same seam as the sidebar card and
// the pane menu. Delete only once nothing is live (archived, or the PTY exited).
async function endSession(id: string | undefined) {
  if (!id) return;
  const tab = store.sessionsList("all").find((row) => row.tab.id === id)?.tab;
  const action = sessionEndAction({
    archived: tab?.archivedAt != null,
    exited: store.sessionLifecycle.get(id) === "exited",
  });
  if (action === "delete") {
    await store.closeSession(id);
    return;
  }
  const state = store.tabRuntime.get(id)?.agentState ?? tab?.lastAgentState;
  if (shouldConfirmArchive(state)) {
    const ok = await ask("Archive Session?", {
      detail: "A process is still running. Archiving stops it and keeps a read-only terminal snapshot.",
      confirmLabel: "Archive",
    });
    if (!ok) return;
  }
  try {
    await store.archiveSession(id);
  } catch (e) {
    window.alert(`Failed to archive session: ${e}`);
  }
}

function onCloseActiveTerminal() {
  const id = store.focusedSessionId;
  if (!id || !dirId.value) return;
  const arr = store.arrangementFor(dirId.value);
  if (arr && paneCount(arr.layout) > 1) store.removeFromView(id); // never kills
  else void endSession(id); // solo: ⌘W now archives (or deletes if nothing is live)
}

// Surface-aware, same routing as ⌘W: with focus in the bottom panel this must
// kill that scratch terminal, not the center session behind it.
function onKillActiveSession() {
  if (store.activeSurface === "bottom" && store.bottomFocusedSessionId) {
    window.dispatchEvent(new CustomEvent("close-active-bottom-pane"));
    return;
  }
  void endSession(store.focusedSessionId);
}

onMounted(() => {
  window.addEventListener("close-active-terminal-tab", onCloseActiveTerminal);
  window.addEventListener("kill-active-terminal-session", onKillActiveSession);
});
onUnmounted(() => {
  window.removeEventListener("close-active-terminal-tab", onCloseActiveTerminal);
  window.removeEventListener("kill-active-terminal-session", onKillActiveSession);
});
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--editor-bg)] relative">
    <!-- Orphaned TabBar affordances: traffic-light clearance + right-panel
         re-expand. Absolute row so it doesn't reserve layout height. -->
    <div
      v-if="leftCollapsed || showRightOverlay"
      class="absolute top-0 left-0 right-0 h-11.5 flex items-center justify-between z-10 pointer-events-none"
    >
      <div v-if="leftCollapsed" class="shrink-0 w-[128px]" />
      <div class="flex-1" />
      <TooltipProvider :delay-duration="250">
        <Tooltip v-if="showRightOverlay">
          <TooltipTrigger as-child>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground pointer-events-auto ml-0.5"
              :aria-label="bottomPanelOpen ? 'Hide Bottom Panel' : 'Show Bottom Panel'"
              @click="toggleBottomPanel"
            >
              <PanelBottomFilled v-if="bottomPanelOpen" class="size-3.5" />
              <PanelBottom v-else class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" class="flex items-center gap-2">
            <span>{{ bottomPanelOpen ? "Hide Bottom Panel" : "Show Bottom Panel" }}</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-bottom-panel')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <Tooltip v-if="showRightOverlay">
          <TooltipTrigger as-child>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground pointer-events-auto ml-0.5 mr-1.5"
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
      </TooltipProvider>
    </div>
    <div class="flex-1 min-h-0 flex flex-col">
      <div v-if="!dirId" class="flex-1 min-h-0 flex items-center justify-center">
        <WelcomeHero v-if="welcome !== 'none'" :mode="welcome === 'hero' ? 'hero' : 'picker'" />
      </div>
      <div
        v-else-if="store.pendingPicker"
        class="flex flex-1 min-h-0 flex-col"
      >
        <div class="drag-region flex h-11.5 shrink-0 items-center gap-1.5 overflow-hidden border-b bg-sidebar pl-4 text-xs text-muted-foreground">
          <Folder aria-hidden="true" class="size-4 text-muted-foreground" />
          <span class="truncate text-muted-foreground">{{ pickerDirectoryName }}</span>
          <span aria-hidden="true" class="text-muted-foreground">/</span>
          <span class="truncate font-medium text-foreground">New Session</span>
        </div>
        <NewSessionPicker
          :key="store.pendingPicker.dirId"
          :dir-id="store.pendingPicker.dirId"
          class="flex-1 min-h-0"
        />
      </div>
      <SplitLayout
        v-else-if="arrangement"
        :key="dirId"
        :node="arrangement.layout"
        :scope-id="dirId"
        :focused-session-id="store.focusedSessionId"
        :multi="paneCount(arrangement.layout) > 1"
        :reserve-right-overlay="showRightOverlay"
        :reserve-left-overlay="!!leftCollapsed"
      />
      <!-- A selected scope without an arrangement intentionally reaches the
           picker branch above; keep this fallback for incomplete hydration. -->
      <div v-else class="flex-1 min-h-0 bg-[var(--editor-bg)]" />
    </div>
  </div>
</template>
