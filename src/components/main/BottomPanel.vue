<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch, type ComponentPublicInstance } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useShortcuts } from "@/composables/useShortcuts";
import { trackSplitterDrag } from "@/composables/usePanelAnimation";
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

// App.vue owns the vertical panel group and therefore the animation gate; we
// only need to know whether a slide is in flight.
const props = defineProps<{ animating?: boolean }>();

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

const height = computed(() => state.value?.height ?? MIN_BOTTOM_HEIGHT_PX);
// Contents stay mounted through a close so the panel isn't blank while it
// slides out, and unmount (releasing their terminals) once it has settled.
const contentVisible = computed(() => !collapsed.value || !!props.animating);
const slideStyle = computed(() =>
  props.animating
    ? {
        position: "absolute" as const,
        left: "0",
        right: "0",
        bottom: "0",
        height: `${height.value}px`,
      }
    : undefined,
);

type SplitterPanel = ComponentPublicInstance & {
  collapse: () => void;
  expand: () => void;
  resize: (size: number) => void;
};
const panelRef = ref<SplitterPanel | null>(null);
watch(collapsed, (isCollapsed) => {
  const panel = panelRef.value;
  if (!panel) return;
  if (isCollapsed) {
    panel.collapse();
    return;
  }
  // reka's expand() restores its own remembered pre-collapse size, which it
  // lacks on a fresh mount — land the persisted height explicitly.
  panel.expand();
  panel.resize(height.value);
});

async function newTerminal() {
  if (!dirId.value) return;
  try {
    await store.createBottomTerminal(dirId.value);
  } catch (e) {
    console.error("[BottomPanel] createBottomTerminal failed:", e);
    window.alert(`Failed to create terminal: ${e}`);
  }
}

function setCollapsed(value: boolean) {
  if (dirId.value && collapsed.value !== value) store.setBottomPanelCollapsed(dirId.value, value);
}

function toggleCollapsed() {
  setCollapsed(!collapsed.value);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function onLayout(sizes: number[]) {
  // The bottom ResizablePanel is only registered with reka-ui while visible
  // (see template) — order 1 is main-upper, order 2 is us. When hidden it isn't
  // registered at all, so `sizes` reports only main-upper's own (percent) size;
  // treating that as our px height would stomp the persisted value with a bogus
  // one. Collapsed reports 0, and mid-slide sizes are transient — skip both.
  if (!visible.value || collapsed.value || props.animating) return;
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
  <template v-if="visible">
    <!-- Hidden (and undraggable) once collapsed, but kept through the slide so
         its divider travels with the panel edge. -->
    <ResizableHandle
      :class="!contentVisible && 'pointer-events-none opacity-0'"
      @dragging="trackSplitterDrag"
    />
    <ResizablePanel
      ref="panelRef"
      :key="dirId ?? undefined"
      id="bottom-panel"
      :order="2"
      :default-size="collapsed ? 0 : height"
      :min-size="MIN_BOTTOM_HEIGHT_PX"
      collapsible
      :collapsed-size="0"
      size-unit="px"
      class="relative bg-[var(--editor-bg)] border-t"
      @collapse="setCollapsed(true)"
      @expand="setCollapsed(false)"
    >
      <!-- Pinned to the expanded height while sliding so the terminals inside
           don't reflow every frame — they slide under the clip instead.
           Anchored to the BOTTOM edge, the one that stays put: the panel's top
           edge is what sweeps, so pinning there would drag the content with
           it instead of revealing it. -->
      <div
        v-if="contentVisible"
        class="relative flex w-full h-full"
        :style="slideStyle"
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
      </div>
    </ResizablePanel>
  </template>
</template>
