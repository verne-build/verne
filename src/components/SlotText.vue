<script setup lang="ts">
import "slot-text/style.css";
import { computed } from "vue";
import { SlotText as LibrarySlotText } from "slot-text/vue";
import type { SlotOptions } from "slot-text";

const props = withDefaults(defineProps<{
  text: string;
  direction?: "up" | "down";
  options?: SlotOptions;
}>(), {
  direction: "down",
});

const mergedOptions = computed<SlotOptions>(() => ({
  direction: props.direction,
  ...props.options,
}));
</script>

<template>
  <LibrarySlotText :text="text" :options="mergedOptions" />
</template>
