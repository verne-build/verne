<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    class?: HTMLAttributes["class"];
    variant?: "default" | "outline";
  }>(),
  { variant: "default" },
);
</script>

<template>
  <kbd
    :class="
      cn(
        'pointer-events-none inline-flex h-4 w-fit min-w-4 items-center justify-center gap-0.5 rounded-sm px-1 font-sans text-[10px] leading-none font-medium select-none',
        '[&_svg:not([class*=\'size-\'])]:size-3',
        props.variant === 'outline'
          ? 'border text-muted-foreground'
          : 'bg-muted text-muted-foreground',
        props.class,
      )
    "
  >
    <slot />
  </kbd>
</template>
