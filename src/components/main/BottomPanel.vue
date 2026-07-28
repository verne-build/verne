<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useShortcuts } from "@/composables/useShortcuts";
import { setSplitterDragging } from "@/composables/useTerminal";
import { bottomSurfaceKey, MIN_BOTTOM_HEIGHT_PX } from "@/lib/bottomPanel";
import { paneCount } from "@/lib/paneLayout";
import { toHorizontal } from "@/lib/bottomList";
import SplitLayout from "./SplitLayout.vue";
import BottomTerminalList from "./BottomTerminalList.vue";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { confirmCloseTerminals } from "@/composables/useConfirmClose";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Plus, PanelBottom } from "@lucide/vue";

const shortcuts = useShortcuts();

const store = useWorkspaceStore();

const dirId = computed(() => store.selectedDirectoryId);
const state = computed(() => (dirId.value ? store.bottomPanelFor(dirId.value) : null));
const visible = computed(() => !!state.value?.tabs.length);
const collapsed = computed(() => !!state.value?.collapsed);
const surfaceKey = computed(() =>
  dirId.value && state.value?.activeTabId
    ? bottomSurfaceKey(dirId.value, state.value.activeTabId)
    : null,
);
const arrangement = computed(() => (surfaceKey.value ? store.arrangementFor(surfaceKey.value) : null));
// Real "v" arrangements can already be on disk (this branch shipped ⌘⇧D
// splitting before this task landed). Normalise for render only — never
// migrate the persisted layout — so an old vertical split still shows as one
// continuous bar instead of two stacked pane headers.
const horizontalLayout = computed(() => (arrangement.value ? toHorizontal(arrangement.value.layout) : null));
const focusedId = computed(() => store.bottomFocusedSessionId);
const splitCount = computed(() => (arrangement.value ? paneCount(arrangement.value.layout) : 0));

// VS Code hides its terminal list until a second terminal exists.
const showList = computed(() => (state.value?.tabs.length ?? 0) > 1);

async function newTerminal() {
  if (!dirId.value) return;
  try {
    await store.createBottomTerminal(dirId.value);
  } catch (e) {
    console.error("[BottomPanel] createBottomTerminal failed:", e);
    window.alert(`Failed to create terminal: ${e}`);
  }
}

function toggleCollapsed() {
  if (dirId.value) store.setBottomPanelCollapsed(dirId.value, !collapsed.value);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function onLayout(sizes: number[]) {
  // The bottom ResizablePanel is only registered with reka-ui while expanded
  // and visible (see template) — order 1 is main-upper, order 2 is us. When
  // collapsed/hidden it isn't registered at all, so `sizes` reports only
  // main-upper's own (percent) size; treating that as our px height would
  // stomp the persisted value with a bogus one.
  if (!visible.value || collapsed.value) return;
  const px = sizes[1];
  if (!dirId.value || !px) return;
  if (saveTimer) clearTimeout(saveTimer);
  const id = dirId.value;
  saveTimer = setTimeout(() => store.setBottomPanelHeight(id, px), 400);
}

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
});

// ⌘W on the bottom surface bypasses the pane menu, so it runs the same shared
// running-process guard.
async function onCloseActivePane() {
  const id = store.bottomFocusedSessionId;
  if (!id) return;
  if (await confirmCloseTerminals([id])) await store.closeBottomPane(id);
}

onMounted(() => window.addEventListener("close-active-bottom-pane", onCloseActivePane));
onUnmounted(() => window.removeEventListener("close-active-bottom-pane", onCloseActivePane));

// App.vue owns the vertical panel group, so it forwards its @layout here.
defineExpose({ onLayout });
</script>

<template>
  <!-- Collapsed renders nothing at all: no strip, no bar (reopen via ⌃`, the
       View menu, or the palette). The pane headers ARE this panel's bar; the
       right column's top cell holds the panel actions so it lines up with them. -->
  <template v-if="visible && !collapsed">
    <ResizableHandle @dragging="setSplitterDragging" />
    <ResizablePanel
      :key="dirId ?? undefined"
      id="bottom-panel"
      :order="2"
      :default-size="state?.height ?? MIN_BOTTOM_HEIGHT_PX"
      :min-size="MIN_BOTTOM_HEIGHT_PX"
      size-unit="px"
      class="relative flex bg-[var(--editor-bg)] border-t"
    >
      <div class="flex-1 min-w-0">
        <SplitLayout
          v-if="horizontalLayout && surfaceKey"
          :key="surfaceKey"
          :node="horizontalLayout"
          :scope-id="surfaceKey"
          :focused-session-id="focusedId"
          :multi="splitCount > 1"
          :reserve-right-overlay="!showList"
          end-mode="close"
          compact
          horizontal-only
        />
      </div>
      <div
        class="flex flex-col"
        :class="
          showList
            ? 'w-56 shrink-0 border-l bg-sidebar'
            : 'absolute right-0 top-0 z-10 h-9'
        "
      >
        <TooltipProvider :delay-duration="250">
          <div class="flex h-9 shrink-0 items-center justify-end gap-0.5 border-b px-1">
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  class="text-muted-foreground"
                  aria-label="New Terminal"
                  @click="newTerminal"
                >
                  <Plus class="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" class="flex items-center gap-2">
                <span>New Terminal</span>
                <KbdGroup>
                  <Kbd v-for="(key, i) in shortcuts.displayKeys('new-terminal')" :key="i">{{ key }}</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  class="text-muted-foreground"
                  aria-label="Hide terminal panel"
                  @click="toggleCollapsed"
                >
                  <PanelBottom class="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" class="flex items-center gap-2">
                <span>Hide Panel</span>
                <KbdGroup>
                  <Kbd v-for="(key, i) in shortcuts.displayKeys('toggle-bottom-panel')" :key="i">{{ key }}</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
        <BottomTerminalList v-if="showList" :dir-id="dirId!" class="min-h-0 flex-1" />
      </div>
    </ResizablePanel>
  </template>
</template>
