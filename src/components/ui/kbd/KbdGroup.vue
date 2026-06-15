<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <span
    data-slot="kbd-group"
    :class="
      cn(
        'inline-flex h-4 shrink-0 items-center gap-0.5 overflow-hidden rounded-[3px] leading-none',
        '[&>kbd]:rounded-none',
        '[&>kbd:first-child]:rounded-l-[3px]',
        '[&>kbd:last-child]:rounded-r-[3px]',
        props.class,
      )
    "
  >
    <slot />
  </span>
</template>
