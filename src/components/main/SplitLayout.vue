<script setup lang="ts">
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
  groupId: string;
  activePaneId?: string;
  multi: boolean;
}>();

const store = useWorkspaceStore();

const key = (n: LayoutNode) => firstLeaf(n);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function onLayout(sizes: number[]) {
  if (isLeaf(props.node)) return;
  const k = nodeKey(props.node);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.updateGroupSizes(props.groupId, k, sizes), 400);
}
</script>

<template>
  <TerminalPane
    v-if="isLeaf(node)"
    :pane-id="node.pane"
    :group-id="groupId"
    :active-pane-id="activePaneId"
    :multi="multi"
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
          :group-id="groupId"
          :active-pane-id="activePaneId"
          :multi="multi"
        />
      </ResizablePanel>
    </template>
  </ResizablePanelGroup>
</template>
