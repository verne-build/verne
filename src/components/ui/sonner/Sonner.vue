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
const toastButtonClasses = "toast-overlay-control toast-opaque-button inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border bg-background px-2 text-xs font-medium text-foreground shadow-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:border-input dark:hover:bg-input/50"
const toastOptions = computed(() => ({
  ...props.toastOptions,
  class: cn(
    floatingSurfaceVariants({ variant: props.variant }),
    "floating-surface-toast toast-interactive-controls",
    props.toastOptions?.class,
  ),
  classes: {
    ...props.toastOptions?.classes,
    title: cn("text-sm", props.toastOptions?.classes?.title),
    closeButton: cn("toast-overlay-control toast-session-active-close", props.toastOptions?.classes?.closeButton),
    actionButton: cn(toastButtonClasses, "toast-outline-button", props.toastOptions?.classes?.actionButton),
    cancelButton: cn(toastButtonClasses, "toast-outline-button", props.toastOptions?.classes?.cancelButton),
  },
}))
const toasterStyle = computed(() => ({
  "--normal-bg": "var(--sidebar)",
  "--normal-text": "var(--sidebar-foreground)",
  "--normal-border": "var(--sidebar-border)",
  "--normal-bg-hover": "var(--sidebar-accent)",
  "--border-radius": "var(--radius-xl)",
  "--toast-control-bg": "rgb(52 52 52)",
  "--toast-control-fg": "var(--secondary-foreground)",
  ...props.style,
} as ToasterProps["style"]))
</script>

<template>
  <Sonner
    v-bind="delegatedProps"
    :close-button-position="props.closeButtonPosition ?? 'top-left'"
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
