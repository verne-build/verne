<script setup lang="ts">
import { useFpsMeter } from "@/composables/useFpsMeter";

const { fpsVisible, fps, maxFps } = useFpsMeter();
</script>

<template>
  <div
    v-if="fpsVisible"
    class="fixed top-1 right-1 z-[99999] pointer-events-none select-none rounded bg-black/60 px-1.5 py-0.5 font-mono text-xs tabular-nums text-green-400"
  >
    {{ fps }} fps<template v-if="maxFps"> / {{ maxFps }} max</template>
  </div>
</template>
