<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, type Ref } from "vue";
import { PanelRight } from "@lucide/vue";
import { ask } from "@/platform";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useShortcuts } from "@/composables/useShortcuts";
import { paneCount } from "@/lib/paneLayout";
import { firstRunView } from "@/lib/firstRunView";
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
const arrangement = computed(() =>
  dirId.value ? store.arrangementFor(dirId.value) : null,
);

const welcome = computed(() =>
  firstRunView({
    directoriesLoaded: store.directoriesLoaded,
    directoryCount: store.directories.length,
    hasSelection: !!store.selectedDirectoryId,
    welcomeSeen: store.welcomeSeen,
  }),
);

async function confirmKill(id: string | undefined) {
  if (!id) return;
  const running = await rpc.request.tabsHasRunningChild({ id }).catch(() => false);
  if (
    running &&
    !(await ask("Close Session?", {
      detail: "A process is still running in this session.",
      confirmLabel: "Close",
    }))
  )
    return;
  await store.closeSession(id);
}

function onCloseActiveTerminal() {
  const id = store.focusedSessionId;
  if (!id || !dirId.value) return;
  const arr = store.arrangementFor(dirId.value);
  if (arr && paneCount(arr.layout) > 1) store.removeFromView(id); // never kills
  else void confirmKill(id); // solo: ⌘W keeps meaning "close" — confirm + kill
}

function onKillActiveSession() {
  void confirmKill(store.focusedSessionId);
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
      v-if="leftCollapsed || (dirId && rightCollapsed)"
      class="absolute top-0 left-0 right-0 h-7 flex items-center justify-between z-10 pointer-events-none"
    >
      <div v-if="leftCollapsed" class="shrink-0 w-[128px]" />
      <div class="flex-1" />
      <TooltipProvider :delay-duration="250">
        <Tooltip v-if="dirId && rightCollapsed">
          <TooltipTrigger as-child>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground pointer-events-auto mr-1.5 mt-1"
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
      <SplitLayout
        v-else-if="arrangement"
        :key="dirId"
        :node="arrangement.layout"
        :scope-id="dirId"
        :focused-session-id="store.focusedSessionId"
        :multi="paneCount(arrangement.layout) > 1"
      />
      <!-- Transient: the scope has no arrangement yet — the empty-scope
           auto-session (ensureLayoutModel2 / selectDirectory / closeSession)
           is creating one. Blank frame keeps the chrome from flashing. -->
      <div v-else class="flex-1 min-h-0 bg-[var(--editor-bg)]" />
    </div>
  </div>
</template>
