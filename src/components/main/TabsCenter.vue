<script setup lang="ts">
import { computed } from "vue";
import { SquareTerminal } from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { paneCount } from "@/lib/paneLayout";
import { firstRunView } from "@/lib/firstRunView";
import TabBar from "./TabBar.vue";
import SplitLayout from "./SplitLayout.vue";
import WelcomeHero from "./WelcomeHero.vue";

const store = useWorkspaceStore();

const dirId = computed(() => store.selectedDirectoryId);
const activeGroup = computed(() => {
  if (!dirId.value) return undefined;
  const gid = store.activeGroupIdByDirectory[dirId.value];
  const groups = store.tabGroupsByDirectory[dirId.value] ?? [];
  return groups.find((g) => g.id === gid) ?? groups[0];
});

const welcome = computed(() =>
  firstRunView({
    directoriesLoaded: store.directoriesLoaded,
    directoryCount: store.directories.length,
    hasSelection: !!store.selectedDirectoryId,
    welcomeSeen: store.welcomeSeen,
  }),
);
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--editor-bg)]">
    <TabBar />
    <div class="flex-1 min-h-0 flex flex-col">
      <div v-if="!dirId" class="flex-1 min-h-0 flex items-center justify-center">
        <WelcomeHero v-if="welcome !== 'none'" :mode="welcome === 'hero' ? 'hero' : 'picker'" />
      </div>
      <!-- Transient state while the last-closed terminal is being recreated:
           keep the pane heading bar so the chrome doesn't flash/collapse. -->
      <template v-else-if="!activeGroup">
        <div
          class="flex items-center pl-4 pr-1 h-8 text-xs bg-sidebar border-b border-border text-muted-foreground shrink-0 gap-1.5"
        >
          <SquareTerminal class="size-3.5 shrink-0" />
        </div>
        <div class="flex-1 min-h-0 bg-[var(--editor-bg)]" />
      </template>
      <SplitLayout
        v-else
        :key="activeGroup.id"
        :node="activeGroup.layout"
        :group-id="activeGroup.id"
        :active-pane-id="activeGroup.activePaneId"
        :multi="paneCount(activeGroup.layout) > 1"
      />
    </div>
  </div>
</template>
