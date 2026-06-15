<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"
import {
  tabBarTriggerVariants,
  tabBarTriggerActiveVariants,
  tabBarTriggerInactiveVariants,
  type TabBarTriggerVariants,
} from "."

const props = defineProps<{
  active?: boolean
  variant?: TabBarTriggerVariants["variant"]
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <button
    :class="cn(
      tabBarTriggerVariants({ variant: props.variant }),
      props.active
        ? tabBarTriggerActiveVariants[props.variant ?? 'default']
        : tabBarTriggerInactiveVariants[props.variant ?? 'default'],
      props.class,
    )"
  >
    <slot />
  </button>
</template>
