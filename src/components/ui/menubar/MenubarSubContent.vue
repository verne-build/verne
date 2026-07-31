<script setup lang="ts">
import type { MenubarSubContentEmits, MenubarSubContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { FloatingSurfaceVariant } from "@/components/ui/floatingSurface"
import { reactiveOmit } from "@vueuse/core"
import {
  MenubarPortal,
  MenubarSubContent,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { floatingSurfaceVariants } from "@/components/ui/floatingSurface"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<MenubarSubContentProps & {
  class?: HTMLAttributes["class"]
  variant?: FloatingSurfaceVariant
}>()
const emits = defineEmits<MenubarSubContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "variant")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <MenubarPortal>
    <MenubarSubContent
      data-slot="menubar-sub-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="
        cn(
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--reka-menubar-content-transform-origin) overflow-hidden rounded-md p-1 shadow-lg',
          floatingSurfaceVariants({ variant: props.variant }),
          props.class,
        )
      "
    >
      <slot />
    </MenubarSubContent>
  </MenubarPortal>
</template>
