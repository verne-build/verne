<script setup lang="ts">
import { computed } from "vue";
import { resolveFileIcon } from "@/composables/useFileIcon";

const props = withDefaults(
  defineProps<{
    name: string;
    size?: number;
  }>(),
  { size: 16 },
);

const icon = computed(() => resolveFileIcon(props.name));
</script>

<template>
  <svg
    class="verne-file-icon shrink-0"
    :data-icon-token="icon.token"
    :width="size"
    :height="size"
    :viewBox="icon.viewBox"
    aria-hidden="true"
  >
    <use :href="`#${icon.symbolId}`" />
  </svg>
</template>
