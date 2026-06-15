<script setup lang="ts">
import { ref } from "vue";
import { CircleHelp, Settings } from "@lucide/vue";
import WorkspacesPanel from "./WorkspacesPanel.vue";
import AgentsPanel from "./AgentsPanel.vue";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcuts } from "@/composables/useShortcuts";
import { readCachedWorkspacesFrac, writeCachedWorkspacesFrac } from "@/lib/bootstrapCache";

const emit = defineEmits<{ (e: "open-settings"): void; (e: "open-shortcuts"): void }>();
const shortcuts = useShortcuts();

// null = auto-fit: workspaces panel grows with its content up to 50% of the
// sidebar, scrolling past that. A number (0..1) is a user-dragged height
// fraction of the sidebar.
const manualFrac = ref<number | null>(readCachedWorkspacesFrac());

const rootEl = ref<HTMLElement | null>(null);
const wsEl = ref<HTMLElement | null>(null);
const dragging = ref(false);

function onHandleDown(e: PointerEvent) {
  const root = rootEl.value;
  const ws = wsEl.value;
  if (!root || !ws) return;
  e.preventDefault();
  dragging.value = true;
  const startY = e.clientY;
  const startPx = ws.offsetHeight;
  const handle = e.currentTarget as HTMLElement;
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    const h = root.clientHeight;
    if (h <= 0) return;
    // keep workspaces header visible and leave room for the agents header
    const px = Math.min(h - 96, Math.max(44, startPx + (ev.clientY - startY)));
    manualFrac.value = px / h;
  };
  const onUp = (ev: PointerEvent) => {
    dragging.value = false;
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    writeCachedWorkspacesFrac(manualFrac.value);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
}

// double-click the handle to return to auto-fit
function resetAuto() {
  manualFrac.value = null;
  writeCachedWorkspacesFrac(null);
}
</script>

<template>
  <div ref="rootEl" class="flex h-full min-h-0 flex-col">
    <div
      ref="wsEl"
      class="flex shrink-0 flex-col overflow-hidden"
      :style="manualFrac === null ? { maxHeight: '50%' } : { height: `${manualFrac * 100}%` }"
    >
      <WorkspacesPanel />
    </div>
    <div class="group relative h-px shrink-0">
      <!-- visible inset line, centered on the 1px boundary -->
      <div
        class="pointer-events-none absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-border transition-[height] group-hover:h-[3px]"
        :class="dragging ? 'h-[3px] bg-primary/40' : ''"
      />
      <!-- invisible grab strip, overlaps both panels without taking layout space -->
      <div
        class="absolute inset-x-0 -top-1 h-2 cursor-row-resize select-none"
        @pointerdown="onHandleDown"
        @dblclick="resetAuto"
      />
    </div>
    <div class="flex min-h-0 flex-1 flex-col">
      <AgentsPanel />
    </div>
    <footer class="flex shrink-0 items-center justify-end gap-0.5 border-t border-border px-1 py-1">
      <TooltipProvider :delay-duration="300">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground hover:text-foreground"
              @click="emit('open-shortcuts')"
            >
              <CircleHelp class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" class="flex items-center gap-2">
            <span>Keyboard Shortcuts</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('shortcuts-help')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground hover:text-foreground"
              @click="emit('open-settings')"
            >
              <Settings class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" class="flex items-center gap-2">
            <span>Settings</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('settings')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </footer>
  </div>
</template>
