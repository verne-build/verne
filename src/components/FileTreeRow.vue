<script setup lang="ts">
import { computed } from "vue";
import type { TreeNode } from "@/composables/useFileTreeModel";
import { resolveFileIconMask } from "@/composables/useFileIcon";

const props = defineProps<{
  node: TreeNode;
  // `expanded` is a primitive prop (not read from node.expanded) so toggling it
  // re-renders the row — node is a stable object ref in a shallowRef Map, so
  // mutating node.expanded in place would not trigger a re-render.
  expanded: boolean;
  selected: boolean;
  renaming: boolean;
  renameValue: string;
  dragOver: boolean;
  dragLabel: string;
}>();
const emit = defineEmits<{
  rowClick: [e: MouseEvent];
  rowDblClick: [e: MouseEvent];
  toggle: [];
  contextmenu: [e: MouseEvent];
  "update:renameValue": [v: string];
  commitRename: [];
  cancelRename: [];
  dragstart: [e: DragEvent];
  dragend: [e: DragEvent];
  drop: [e: DragEvent];
  dragover: [e: DragEvent];
}>();

const icon = computed(() =>
  props.node.isDir ? null : resolveFileIconMask(props.node.name),
);

// Our own caret glyph (down chevron); rotated -90deg when collapsed. Dirs show
// only this caret (no separate folder-icon glyph), matching the prior design.
const CARET = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><path fill="#000" d="M300.3 440.8C312.9 451 331.4 450.3 343.1 438.6L471.1 310.6C480.3 301.4 483 287.7 478 275.7C473 263.7 461.4 256 448.5 256L192.5 256C179.6 256 167.9 263.8 162.9 275.8C157.9 287.8 160.7 301.5 169.9 310.6L297.9 438.6L300.3 440.8z"/></svg>',
)}")`;

// Use a custom drag image: the default ghost is blank because the virtualizer
// wrapper has a CSS transform (WebKit can't snapshot a transformed subtree).
function onDragStart(e: DragEvent) {
  const ghost = document.createElement("div");
  ghost.textContent = props.dragLabel || props.node.name || "item";
  ghost.style.cssText =
    "position:fixed;top:-1000px;left:-1000px;padding:2px 8px;border-radius:6px;" +
    "font-size:12px;white-space:nowrap;background:var(--color-tab-active-bg);" +
    "color:var(--color-foreground);box-shadow:0 1px 4px rgba(0,0,0,.3);";
  document.body.appendChild(ghost);
  e.dataTransfer?.setDragImage(ghost, 0, 0);
  setTimeout(() => ghost.remove(), 0);
  emit("dragstart", e);
}

// Stop propagation so the tree's keyboard-nav handler (and global shortcuts)
// don't hijack arrows / Cmd+A / text selection while editing the name.
function onRenameKeydown(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key === "Enter") { e.preventDefault(); emit("commitRename"); }
  else if (e.key === "Escape") { e.preventDefault(); emit("cancelRename"); }
}
</script>

<template>
  <div
    class="file-row flex items-center h-[22px] mx-1 pr-1.5 cursor-default select-none rounded-md"
    :class="[
      selected
        ? 'bg-[var(--color-tab-active-bg)] text-[var(--color-foreground)]'
        : 'text-[var(--color-soft-foreground)] hover:bg-[color-mix(in_oklch,var(--color-border)_25%,transparent)]',
      dragOver ? 'bg-[color-mix(in_oklch,var(--color-soft-foreground)_15%,transparent)] ring-1 ring-inset ring-[var(--color-soft-foreground)]' : '',
      node.isIgnored ? 'opacity-50' : '',
    ]"
    :style="{ paddingLeft: `${node.depth * 20 + 6}px` }"
    :data-item-path="node.path"
    :data-item-type="node.isDir ? 'directory' : 'file'"
    draggable="true"
    @click="emit('rowClick', $event)"
    @dblclick="emit('rowDblClick', $event)"
    @contextmenu.prevent="emit('contextmenu', $event)"
    @dragstart="onDragStart"
    @dragend="emit('dragend', $event)"
    @dragover.prevent="emit('dragover', $event)"
    @drop.prevent="emit('drop', $event)"
  >
    <!-- One leading glyph per row (caret for dirs, type icon for files), same
         width + margin. With indent step = glyph + margin (20px), a child's
         glyph aligns directly under its parent's label. -->
    <span
      v-if="node.isDir"
      class="mask-icon size-3.5 shrink-0 mr-1.5 transition-transform"
      :class="expanded ? 'rotate-0' : '-rotate-90'"
      :style="{ '--m': CARET, backgroundColor: 'var(--color-muted-foreground)' }"
      @click.stop="emit('toggle')"
    />
    <span
      v-else
      class="mask-icon size-3.5 shrink-0 mr-1.5"
      :style="{ '--m': icon!.maskUrl, backgroundColor: `var(--trees-file-icon-color-${icon!.token ?? 'default'})` }"
    />

    <input
      v-if="renaming"
      v-focus
      class="min-w-0 flex-1 bg-transparent outline outline-1 outline-[var(--color-border)] rounded px-1 text-[12px]"
      :value="renameValue"
      @input="emit('update:renameValue', ($event.target as HTMLInputElement).value)"
      @keydown="onRenameKeydown"
      @blur="emit('commitRename')"
      @click.stop
    />
    <span v-else class="min-w-0 flex-1 truncate text-[12px]">{{ node.name }}</span>
  </div>
</template>

<style scoped>
.mask-icon {
  -webkit-mask-image: var(--m);
  mask-image: var(--m);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
}
.file-row { contain: layout style; }
</style>
