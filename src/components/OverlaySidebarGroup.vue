<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./ui/resizable";
import { PANEL_SIZES } from "@/lib/panelSizes";
import { overlayWidth } from "@/lib/overlaySidebar";
import type { PanelResizeState } from "@/composables/usePanelResizeState";

const props = defineProps<{
  state: PanelResizeState;
  /** Live width of the right panel — drives the overlay's clamped width. */
  containerWidth: number;
}>();

const LIST_PANEL_MIN_PX = PANEL_SIZES.list.min;
const LIST_PANEL_MAX_PX = PANEL_SIZES.list.max;

const splitDragging = ref(false);

// reka-ui fires @collapse mid-drag once the panel crosses its min; snap back
// instead of letting a drag close the sidebar. Inert while overlaid — the
// closed state there is a transform, not a collapse.
function preventDragCollapse() {
  if (!splitDragging.value || props.state.overlayMode.value) return;
  props.state.panelRef.value?.resize?.(LIST_PANEL_MIN_PX);
}

const sidebarStyle = computed(() =>
  props.state.overlayMode.value
    ? { width: `${overlayWidth(props.state.sizePx.value, props.containerWidth)}px` }
    : undefined,
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.state.overlayMode.value && props.state.overlayOpen.value) {
    e.stopPropagation();
    props.state.dismissOverlay();
  }
}

// Only listen while an overlay is actually open, so Esc keeps reaching Monaco,
// dialogs, and the terminal everywhere else.
watch(
  () => props.state.overlayMode.value && props.state.overlayOpen.value,
  (on) => {
    if (on) window.addEventListener("keydown", onKeydown, true);
    else window.removeEventListener("keydown", onKeydown, true);
  },
);
onMounted(() => {
  if (props.state.overlayMode.value && props.state.overlayOpen.value)
    window.addEventListener("keydown", onKeydown, true);
});
onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));
</script>

<template>
  <div
    class="relative h-full overflow-hidden"
    :class="{
      'overlay-mode': state.overlayMode.value,
      'overlay-closed': state.overlayMode.value && !state.overlayOpen.value,
    }"
  >
    <ResizablePanelGroup direction="horizontal" class="h-full" @layout="state.onLayout">
      <ResizablePanel
        :ref="(el) => (state.panelRef.value = el)"
        collapsible
        :collapsed-size="0"
        :default-size="state.sizePx.value"
        :min-size="LIST_PANEL_MIN_PX"
        :max-size="LIST_PANEL_MAX_PX"
        size-unit="px"
        class="overlay-sidebar bg-sidebar"
        :style="sidebarStyle"
        @collapse="preventDragCollapse"
      >
        <slot name="sidebar" />
      </ResizablePanel>
      <ResizableHandle class="overlay-handle cursor-ew-resize" @dragging="splitDragging = $event" />
      <ResizablePanel :min-size="20" class="overlay-content">
        <slot name="content" />
      </ResizablePanel>
    </ResizablePanelGroup>
    <Transition name="scrim">
      <div
        v-if="state.overlayMode.value && state.overlayOpen.value"
        data-overlay-scrim
        class="absolute inset-0 z-10 bg-black/40"
        @click="state.dismissOverlay()"
      />
    </Transition>
  </div>
</template>

<style scoped>
/* Overlay mode: lift the sidebar out of the flex flow so the content keeps the
   full width underneath. Overrides reka-ui's inline flex — same technique as
   .is-file-maximized in App.vue. The wrapper must stay the nearest positioned
   ancestor and must NOT set a z-index, or it would trap the sidebar (z-20)
   below the scrim (z-10). */
.overlay-mode :deep(.overlay-sidebar) {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 20;
  border-right: 1px solid var(--border);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
  transition: transform 150ms ease;
}

.overlay-mode.overlay-closed :deep(.overlay-sidebar) {
  transform: translateX(-100%);
  pointer-events: none;
}

.overlay-mode :deep(.overlay-content) {
  flex: 1 1 0% !important;
}

.overlay-mode :deep(.overlay-handle) {
  display: none !important;
}

.scrim-enter-active,
.scrim-leave-active {
  transition: opacity 150ms ease;
}

.scrim-enter-from,
.scrim-leave-to {
  opacity: 0;
}
</style>
