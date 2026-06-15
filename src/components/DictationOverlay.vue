<script setup lang="ts">
import { computed } from "vue";
import { useDictation } from "@/composables/useDictation";

const { state, partial, errorMessage } = useDictation();

const visible = computed(
  () =>
    state.value === "starting" ||
    state.value === "listening" ||
    state.value === "stopping" ||
    state.value === "error",
);

const label = computed(() => {
  if (state.value === "error") return errorMessage.value || "Dictation error";
  if (state.value === "starting") return "Starting…";
  if (state.value === "stopping") return "Finishing…";
  return partial.value || "Listening…";
});
</script>

<template>
  <Transition name="dictation-fade">
    <div v-if="visible" class="dictation-overlay" :class="{ error: state === 'error' }">
      <span class="dot" :class="{ live: state === 'listening' }" />
      <span class="text">{{ label }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.dictation-overlay {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 60vw;
  padding: 8px 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--background, #1e1e1e) 85%, transparent);
  border: 1px solid var(--border, #333);
  color: var(--foreground, #eee);
  font-size: 13px;
  z-index: 9999;
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.dictation-overlay.error {
  border-color: #e5484d;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #888;
  flex: none;
}
.dot.live {
  background: #e5484d;
  animation: dictation-pulse 1s infinite;
}
.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes dictation-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.dictation-fade-enter-active,
.dictation-fade-leave-active {
  transition: opacity 0.15s;
}
.dictation-fade-enter-from,
.dictation-fade-leave-to {
  opacity: 0;
}
</style>
