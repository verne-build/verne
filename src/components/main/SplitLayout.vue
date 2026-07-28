<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { setSplitterDragging } from "@/composables/useTerminal";
import { isLeaf, firstLeaf, nodeKey } from "@/lib/paneLayout";
import type { LayoutNode } from "@/types";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import TerminalPane from "./TerminalPane.vue";

const props = defineProps<{
  node: LayoutNode;
  scopeId: string;
  focusedSessionId?: string;
  multi: boolean;
  reserveRightOverlay?: boolean;
  /** Reserve the top-left window-control + toggle/search strip's overlay slot.
   *  Forwarded only to the FIRST child at each level, so exactly the top-left
   *  pane pads — the strip overlaps nothing else. */
  reserveLeftOverlay?: boolean;
  /** Forwarded to every pane: how ⌘W / the pane menu ends it. */
  endMode?: "archive" | "close";
  /** Forwarded to every pane: compact header height. */
  compact?: boolean;
  /** Forwarded to every pane: side-by-side splits only. */
  horizontalOnly?: boolean;
}>();

const store = useWorkspaceStore();

const key = (n: LayoutNode) => firstLeaf(n);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function onLayout(sizes: number[]) {
  if (isLeaf(props.node)) return;
  const k = nodeKey(props.node);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.setArrangementSizes(props.scopeId, k, sizes), 400);
}

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<template>
  <TerminalPane
    v-if="isLeaf(node)"
    :pane-id="node.pane"
    :scope-id="scopeId"
    :focused-session-id="focusedSessionId"
    :multi="multi"
    :reserve-right-overlay="reserveRightOverlay"
    :reserve-left-overlay="reserveLeftOverlay"
    :end-mode="endMode"
    :compact="compact"
    :horizontal-only="horizontalOnly"
  />
  <ResizablePanelGroup
    v-else
    :key="nodeKey(node)"
    :direction="node.direction === 'h' ? 'horizontal' : 'vertical'"
    class="h-full w-full"
    @layout="onLayout"
  >
    <template v-for="(child, i) in node.children" :key="key(child)">
      <ResizableHandle v-if="i > 0" @dragging="setSplitterDragging" />
      <ResizablePanel
        :id="key(child)"
        :order="i + 1"
        :default-size="node.sizes[i] ?? 100 / node.children.length"
        :min-size="8"
        class="min-h-0 min-w-0"
      >
        <SplitLayout
          :node="child"
          :scope-id="scopeId"
          :focused-session-id="focusedSessionId"
          :multi="multi"
          :reserve-right-overlay="
            reserveRightOverlay && (node.direction === 'v' || i === node.children.length - 1)
          "
          :reserve-left-overlay="reserveLeftOverlay && i === 0"
          :end-mode="endMode"
          :compact="compact"
          :horizontal-only="horizontalOnly"
        />
      </ResizablePanel>
    </template>
  </ResizablePanelGroup>
</template>
