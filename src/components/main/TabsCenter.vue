<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, provide, watch, type Ref } from "vue";
import { Folder } from "@lucide/vue";
import { ask } from "@/platform";
import { sessionEndAction, shouldConfirmArchive } from "@/lib/sessionEnd";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { paneCount } from "@/lib/paneLayout";
import { firstRunView } from "@/lib/firstRunView";
import { deriveCenterPanePlacements } from "@/lib/centerPanePlacement";
import NewSessionPicker from "./NewSessionPicker.vue";
import PersistentCenterPaneHost from "./PersistentCenterPaneHost.vue";
import SplitLayout from "./SplitLayout.vue";
import WelcomeHero from "./WelcomeHero.vue";
import {
  centerPaneAnchorRegistryKey,
  createCenterPaneAnchorRegistry,
} from "./centerPaneAnchorRegistry";

const store = useWorkspaceStore();
const rpc = useRpc();
const centerPaneAnchorRegistry = createCenterPaneAnchorRegistry();
provide(centerPaneAnchorRegistryKey, centerPaneAnchorRegistry);

const rightCollapsed = inject<Ref<boolean>>("rightCollapsed");
const leftCollapsed = inject<Ref<boolean>>("leftCollapsed");
const dirId = computed(() => store.selectedDirectoryId);
const showRightOverlay = computed(() => !!dirId.value && !!rightCollapsed?.value);
const arrangement = computed(() =>
  dirId.value ? store.centerDisplayArrangementFor(dirId.value) : null,
);
const centerPanePlacements = computed(() => {
  if (!dirId.value || !arrangement.value || store.pendingPicker)
    return [];
  return deriveCenterPanePlacements(arrangement.value.layout, {
    scopeId: dirId.value,
    focusedSessionId: store.focusedSessionId,
    reserveRightOverlay: showRightOverlay.value,
    reserveLeftOverlay: !!leftCollapsed?.value,
  });
});

watch(dirId, (nextDirectoryId, previousDirectoryId) => {
  if (previousDirectoryId !== nextDirectoryId) centerPaneAnchorRegistry.clear();
}, { flush: "sync" });
const pickerDirectoryName = computed(() => {
  const id = store.pendingPicker?.dirId;
  return store.directories.find((directory) => directory.id === id)?.name ?? "Workspace";
});

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
  centerPaneAnchorRegistry.clear();
  window.removeEventListener("close-active-terminal-tab", onCloseActiveTerminal);
  window.removeEventListener("kill-active-terminal-session", onKillActiveSession);
});
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--editor-bg)] relative">
    <!-- Orphaned TabBar affordances: traffic-light clearance + panel toggles.
         Absolute row so it doesn't reserve layout height. The transparent
         border-b mirrors the bordered bars this overlays (pane header, file tab
         bar): border-box shrinks their content box to 45px, so without it these
         buttons centre half a pixel lower and visibly jump when the right panel
         opens. -->
    <!-- Left-side spacer only. The right-hand toggles used to live here as a
         second copy of FileTabBar's actions; they are now one persistent strip
         in App.vue that never remounts across a panel toggle. -->
    <div
      v-if="leftCollapsed"
      class="absolute top-0 left-0 right-0 h-11.5 border-b border-transparent flex items-center z-10 pointer-events-none"
    >
      <div class="shrink-0 w-[128px]" />
      <div class="flex-1" />
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
      <div
        v-else-if="arrangement"
        :key="dirId"
        class="flex-1 min-h-0"
      >
        <SplitLayout
          :node="arrangement.layout"
          :scope-id="dirId"
          :focused-session-id="store.focusedSessionId"
          :multi="paneCount(arrangement.layout) > 1"
          :reserve-right-overlay="showRightOverlay"
          :reserve-left-overlay="!!leftCollapsed"
          center-display
        />
        <PersistentCenterPaneHost :placements="centerPanePlacements" />
      </div>
      <!-- A selected scope without an arrangement intentionally reaches the
           picker branch above; keep this fallback for incomplete hydration. -->
      <div v-else class="flex-1 min-h-0 bg-[var(--editor-bg)]" />
    </div>
  </div>
</template>
