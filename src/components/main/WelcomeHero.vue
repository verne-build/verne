<!-- src/components/main/WelcomeHero.vue -->
<script setup lang="ts">
import { FolderOpen } from "@lucide/vue";
import logoUrl from "@/assets/logo.svg";
import { useWorkspaceStore } from "@/stores/workspace";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

defineProps<{ mode: "hero" | "picker" }>();

const store = useWorkspaceStore();
</script>

<template>
  <Empty class="verne-hero h-full border-none">
    <EmptyHeader>
      <EmptyMedia>
        <img
          :src="logoUrl"
          alt="Verne"
          draggable="false"
          :class="mode === 'hero' ? 'verne-mark w-56 select-none' : 'w-28 opacity-90 select-none'"
        />
      </EmptyMedia>
      <template v-if="mode === 'hero'">
        <EmptyTitle class="sr-only">Welcome to Verne</EmptyTitle>
        <EmptyDescription>The IDE for your CLI agents.</EmptyDescription>
      </template>
      <template v-else>
        <EmptyDescription>Pick a workspace to continue</EmptyDescription>
      </template>
    </EmptyHeader>
    <EmptyContent>
      <Button variant="outline" :disabled="store.picking" @click="store.openAndSelectWorkspace()">
        <FolderOpen />
        Open Folder
        <Kbd v-if="mode === 'hero'" variant="outline" class="ml-1">⌘O</Kbd>
      </Button>
    </EmptyContent>
  </Empty>
</template>

<style scoped>
.verne-hero {
  animation: verne-fade-up 0.4s ease-out;
}
.verne-mark {
  animation: verne-breathe 4s ease-in-out infinite;
}
@keyframes verne-fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@keyframes verne-breathe {
  0%, 100% { opacity: 0.92; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .verne-hero, .verne-mark { animation: none; }
}
</style>
