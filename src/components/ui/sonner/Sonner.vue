<script lang="ts" setup>
import type { ToasterProps } from "vue-sonner"
import type { FloatingSurfaceVariant } from "@/components/ui/floatingSurface"
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "@lucide/vue"
import { reactiveOmit } from "@vueuse/core"
import { computed } from "vue"
import { Toaster as Sonner } from "vue-sonner"
import { floatingSurfaceVariants } from "@/components/ui/floatingSurface"
import { cn } from "@/lib/utils"

const props = defineProps<ToasterProps & { variant?: FloatingSurfaceVariant }>()
const delegatedProps = reactiveOmit(props, "variant", "class", "style", "toastOptions")
const toastOptions = computed(() => ({
  ...props.toastOptions,
  class: cn(
    floatingSurfaceVariants({ variant: props.variant }),
    props.toastOptions?.class,
  ),
}))
const toasterStyle = computed(() => ({
  "--normal-bg": "var(--sidebar)",
  "--normal-text": "var(--sidebar-foreground)",
  "--normal-border": "var(--sidebar-border)",
  "--normal-bg-hover": "var(--sidebar-accent)",
  "--border-radius": "var(--radius)",
  ...props.style,
} as ToasterProps["style"]))
</script>

<template>
  <Sonner
    v-bind="delegatedProps"
    :class="cn('toaster group', props.class)"
    :style="toasterStyle"
    :toast-options="toastOptions"
  >
    <template #success-icon>
      <CircleCheckIcon class="size-4" />
    </template>
    <template #info-icon>
      <InfoIcon class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon class="size-4" />
    </template>
    <template #error-icon>
      <OctagonXIcon class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Loader2Icon class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-4" />
    </template>
  </Sonner>
</template>
