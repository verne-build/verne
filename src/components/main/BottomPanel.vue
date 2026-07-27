<script setup lang="ts">
import { computed } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { setSplitterDragging } from "@/composables/useTerminal";
import { bottomSurfaceKey, MIN_BOTTOM_HEIGHT_PX } from "@/lib/bottomPanel";
import { paneCount } from "@/lib/paneLayout";
import SplitLayout from "./SplitLayout.vue";
import BottomTabBar from "./BottomTabBar.vue";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

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
const focusedId = computed(() => store.bottomFocusedSessionId);

function toggleCollapsed() {
  if (dirId.value) store.setBottomPanelCollapsed(dirId.value, !collapsed.value);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function onLayout(sizes: number[]) {
  const px = sizes[sizes.length - 1];
  if (!dirId.value || !px) return;
  if (saveTimer) clearTimeout(saveTimer);
  const id = dirId.value;
  saveTimer = setTimeout(() => store.setBottomPanelHeight(id, px), 400);
}

// App.vue owns the vertical panel group, so it forwards its @layout here.
defineExpose({ onLayout });
</script>

<template>
  <!-- Expanded: a vertical split so the center + right shrink. Collapsed: just
       the tab bar, parked below them with no handle. -->
  <template v-if="visible">
    <template v-if="!collapsed">
      <ResizableHandle @dragging="setSplitterDragging" />
      <ResizablePanel
        id="bottom-panel"
        :order="2"
        :default-size="state?.height ?? MIN_BOTTOM_HEIGHT_PX"
        :min-size="MIN_BOTTOM_HEIGHT_PX"
        size-unit="px"
        class="flex flex-col bg-[var(--editor-bg)] border-t"
      >
        <BottomTabBar :dir-id="dirId!" :collapsed="false" @toggle-collapsed="toggleCollapsed" />
        <div class="flex-1 min-h-0">
          <SplitLayout
            v-if="arrangement && surfaceKey"
            :key="surfaceKey"
            :node="arrangement.layout"
            :scope-id="surfaceKey"
            :focused-session-id="focusedId"
            :multi="paneCount(arrangement.layout) > 1"
            end-mode="close"
          />
        </div>
      </ResizablePanel>
    </template>
    <div v-else class="shrink-0 border-t">
      <BottomTabBar :dir-id="dirId!" :collapsed="true" @toggle-collapsed="toggleCollapsed" />
    </div>
  </template>
</template>
