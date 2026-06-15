<script setup lang="ts">
import { ref, computed, onActivated, nextTick } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { TreeNode } from "@/composables/useFileTreeModel";
import FileTreeRow from "./FileTreeRow.vue";

const props = defineProps<{
  rows: TreeNode[];
  selected: Set<string>;
  renamingPath: string | null;
  renameValue: string;
  dragOverDir: string | null;
}>();
const emit = defineEmits<{
  rowClick: [node: TreeNode, e: MouseEvent];
  rowDblClick: [node: TreeNode, e: MouseEvent];
  toggle: [node: TreeNode];
  contextmenu: [node: TreeNode, e: MouseEvent];
  "update:renameValue": [v: string];
  commitRename: [];
  cancelRename: [];
  scroll: [top: number];
  keydown: [e: KeyboardEvent];
  dragstart: [node: TreeNode, e: DragEvent];
  dragover: [node: TreeNode, e: DragEvent];
  dragend: [e: DragEvent];
  drop: [node: TreeNode, e: DragEvent];
}>();

const scrollEl = ref<HTMLDivElement | null>(null);

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.rows.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => 22,
    overscan: 12,
  })),
);

// Filter to in-bounds indices: getVirtualItems() can be one tick stale relative
// to a just-shrunk `rows` (rapid collapse / drag removal), which would index
// past the array end in the v-for.
const items = computed(() =>
  virtualizer.value.getVirtualItems().filter((vi) => vi.index < props.rows.length),
);
const totalSize = computed(() => virtualizer.value.getTotalSize());

// Drag-ghost label: "N items" when dragging within a multi-selection, else name.
function dragLabelFor(node: TreeNode): string {
  return props.selected.has(node.path) && props.selected.size > 1
    ? `${props.selected.size} items`
    : node.name;
}

function onScroll() {
  if (scrollEl.value) emit("scroll", scrollEl.value.scrollTop);
}

// Reactivated from KeepAlive: while cached the scroll element was detached (0
// height), so the virtualizer's range was computed against a stale size and rows
// render mispositioned until the next scroll recalculates. Force a re-measure
// once reattached + sized, then nudge the scroll observer (the programmatic
// equivalent of scrolling 1px) so the range recomputes immediately.
onActivated(() => {
  nextTick(() => {
    virtualizer.value.measure();
    scrollEl.value?.dispatchEvent(new Event("scroll"));
  });
});

defineExpose({
  scrollToIndex: (i: number) => virtualizer.value.scrollToIndex(i, { align: "auto" }),
  getScrollTop: () => scrollEl.value?.scrollTop ?? 0,
  setScrollTop: (n: number) => { if (scrollEl.value) scrollEl.value.scrollTop = n; },
});
</script>

<template>
  <div
    ref="scrollEl"
    class="app-scrollbar h-full overflow-auto focus:outline-none"
    tabindex="0"
    @scroll="onScroll"
    @keydown="(e) => emit('keydown', e)"
  >
    <div :style="{ height: `${totalSize}px`, position: 'relative', width: '100%' }">
      <div
        v-for="vi in items"
        :key="rows[vi.index].path"
        :style="{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }"
      >
        <FileTreeRow
          :node="rows[vi.index]"
          :expanded="rows[vi.index].expanded"
          :selected="selected.has(rows[vi.index].path)"
          :renaming="renamingPath === rows[vi.index].path"
          :rename-value="renameValue"
          :drag-over="rows[vi.index].isDir && rows[vi.index].path === dragOverDir"
          :drag-label="dragLabelFor(rows[vi.index])"
          @row-click="(e) => emit('rowClick', rows[vi.index], e)"
          @row-dbl-click="(e) => emit('rowDblClick', rows[vi.index], e)"
          @toggle="emit('toggle', rows[vi.index])"
          @contextmenu="(e) => emit('contextmenu', rows[vi.index], e)"
          @update:rename-value="(v) => emit('update:renameValue', v)"
          @commit-rename="emit('commitRename')"
          @cancel-rename="emit('cancelRename')"
          @dragstart="(e) => emit('dragstart', rows[vi.index], e)"
          @dragover="(e) => emit('dragover', rows[vi.index], e)"
          @dragend="(e) => emit('dragend', e)"
          @drop="(e) => emit('drop', rows[vi.index], e)"
        />
      </div>
    </div>
  </div>
</template>
