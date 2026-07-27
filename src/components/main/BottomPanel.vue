<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { setSplitterDragging } from "@/composables/useTerminal";
import { bottomSurfaceKey, MIN_BOTTOM_HEIGHT_PX } from "@/lib/bottomPanel";
import { paneCount } from "@/lib/paneLayout";
import SplitLayout from "./SplitLayout.vue";
import BottomTabBar from "./BottomTabBar.vue";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useRpc } from "@/composables/useRpc";
import { ask } from "@/platform";

const store = useWorkspaceStore();
const rpc = useRpc();

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
const splitCount = computed(() => (arrangement.value ? paneCount(arrangement.value.layout) : 0));

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

// ⌘W on the bottom surface bypasses TerminalPane.confirmKill, so mirror its
// running-process guard here.
async function onCloseActivePane() {
  const id = store.bottomFocusedSessionId;
  if (!id) return;
  const running = await rpc.request.tabsHasRunningChild({ id }).catch(() => false);
  if (running) {
    const label = store.tabRuntime.get(id)?.foregroundCommand || "A process";
    const ok = await ask("Close Terminal?", {
      detail: `${label} is still running. Closing kills it.`,
      confirmLabel: "Close",
    });
    if (!ok) return;
  }
  await store.closeBottomPane(id);
}

onMounted(() => window.addEventListener("close-active-bottom-pane", onCloseActivePane));
onUnmounted(() => window.removeEventListener("close-active-bottom-pane", onCloseActivePane));

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
        :key="dirId ?? undefined"
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
            :multi="splitCount > 1"
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
