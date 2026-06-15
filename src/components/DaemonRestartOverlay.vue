<script setup lang="ts">
// Full-screen cover shown while the daemon hard-restarts (menu "Restart Daemon").
// The daemon goes away for a few seconds, so daemon-backed UI hangs; this gives
// immediate feedback instead of a frozen window. Main sends `daemon-restart`
// {active:true} before the restart and {active:false} only on failure — on
// success the renderer is reloaded, which clears the overlay via a fresh mount.
import { ref, onMounted, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@/platform";

const restarting = ref(false);
let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await listen<{ active?: boolean }>("daemon-restart", ({ payload }) => {
    restarting.value = payload?.active !== false;
  });
});
onUnmounted(() => unlisten?.());
</script>

<template>
  <Transition name="restart-fade">
    <div
      v-if="restarting"
      class="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-sm"
    >
      <div
        class="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
      <p class="text-sm text-muted-foreground">Restarting daemon…</p>
    </div>
  </Transition>
</template>

<style scoped>
.restart-fade-enter-active,
.restart-fade-leave-active {
  transition: opacity 0.15s ease;
}
.restart-fade-enter-from,
.restart-fade-leave-to {
  opacity: 0;
}
</style>
