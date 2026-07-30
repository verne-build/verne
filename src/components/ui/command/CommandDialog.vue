<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { useForwardPropsEmits } from "reka-ui"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from "@/lib/utils"
import Command from "./Command.vue"

const props = withDefaults(defineProps<DialogRootProps & {
  title?: string
  description?: string
  ignoreFilter?: boolean
  showOverlay?: boolean
  contentClass?: HTMLAttributes["class"]
}>(), {
  title: "Command Palette",
  description: "Search for a command to run...",
  ignoreFilter: false,
  showOverlay: false,
})
const emits = defineEmits<DialogRootEmits>()

const delegatedProps = reactiveOmit(props, "title", "description", "ignoreFilter", "showOverlay", "contentClass")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <Dialog v-slot="slotProps" v-bind="forwarded">
    <DialogContent
      :class="cn('overflow-hidden p-0 sm:max-w-[550px] sm:w-[550px]', contentClass)"
      :show-close-button="false"
      :show-overlay="showOverlay"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <Command :ignore-filter="ignoreFilter">
        <slot v-bind="slotProps" />
      </Command>
    </DialogContent>
  </Dialog>
</template>
