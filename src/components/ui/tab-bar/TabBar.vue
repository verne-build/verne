<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"
import { cva } from "class-variance-authority";
import { useSlots, computed } from "vue";

const props = defineProps<{
  variant?: "default" | "sidebar" | "grouped" | "pill"
  class?: HTMLAttributes["class"]
}>()

const slots = useSlots()
const hasActions = computed(() => !!slots.actions)

const tabBarVariants = cva(
  // `drag-region` makes the whole bar a window-drag handle, handled in JS by
  // `useWindowDrag` (native `-webkit-app-region` drag is disabled app-wide — see
  // style.css). Interactive children (tabs, buttons) are excluded by that
  // composable's no-drag selector, so they stay clickable while empty bar areas
  // drag the window. Same dragging style as the persistent top-left controls.
  "drag-region flex shrink-0 items-center text-xs transition-colors relative",
  {
    variants: {
      variant: {
        default: "h-11.5 relative shrink-0 flex border-b border-tab-border",
        sidebar: "h-11.5 relative shrink-0 flex border-b border-tab-border",
        grouped: "flex items-center shrink-0 h-11.5 border-b border-border px-1.5",
        pill: "h-11.5 relative shrink-0 flex border-b border-tab-border px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
</script>

<template>
  <div
    :class="cn(tabBarVariants({ variant: props.variant }), props.class)"
  >
    <template v-if="props.variant === 'grouped'">
      <div class="relative inline-flex items-center rounded-md border border-border overflow-hidden">
        <slot />
      </div>
      <div class="relative flex items-center">
        <slot name="actions" />
      </div>
    </template>
    <template v-else-if="props.variant === 'pill'">
      <div class="relative inline-flex gap-0.5 min-w-0 flex-1 items-center h-11.5">
        <slot />
      </div>
      <div class="relative flex items-center">
        <slot name="actions" />
      </div>
    </template>
    <template v-else>
      <div class="relative flex min-w-0 flex-1 items-center h-11.5">
        <slot />
      </div>
      <div
        v-if="hasActions"
        class="relative flex items-center gap-0.5 px-1.5 h-11.5 text-muted-foreground shrink-0 border-l border-l-tab-border"
      >
        <slot name="actions" />
      </div>
    </template>
  </div>
</template>
