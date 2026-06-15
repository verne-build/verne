<script setup lang="ts">
import type { SplitterResizeHandleEmits, SplitterResizeHandleProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { GripVertical } from "@lucide/vue"
import { SplitterResizeHandle, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<SplitterResizeHandleProps & { class?: HTMLAttributes["class"], withHandle?: boolean }>()
const emits = defineEmits<SplitterResizeHandleEmits>()

const delegatedProps = reactiveOmit(props, "class", "withHandle")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SplitterResizeHandle
    data-slot="resizable-handle"
    v-bind="forwarded"
    :class="cn('group focus-visible:ring-ring relative z-50 flex w-0 items-center justify-center focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden data-[orientation=vertical]:h-0 data-[orientation=vertical]:w-full', props.class)"
  >
    <!-- Horizontal handle bar -->
    <div class="pointer-events-none absolute z-10 inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-[width] duration-150 group-data-[state=hover]:w-[7px] group-data-[state=drag]:w-[7px] group-data-[orientation=vertical]:hidden" />
    <!-- Vertical handle bar -->
    <div class="pointer-events-none absolute z-10 inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-[height] duration-150 group-data-[state=hover]:h-[7px] group-data-[state=drag]:h-[7px] hidden group-data-[orientation=vertical]:block" />
    <template v-if="props.withHandle">
      <div class="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
        <slot>
          <GripVertical class="size-2.5" />
        </slot>
      </div>
    </template>
  </SplitterResizeHandle>
</template>
