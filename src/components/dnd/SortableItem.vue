<script setup lang="ts">
import { ref } from "vue";
import { useSortable } from "@dnd-kit/vue/sortable";
import { closestCorners } from "@dnd-kit/collision";
import type { CollisionDetector } from "@dnd-kit/abstract";

const props = defineProps<{
  id: string;
  index: number;
  group?: string;
  disabled?: boolean;
  as?: string;
  collisionDetector?: CollisionDetector;
}>();

const el = ref<HTMLElement | null>(null);
// `group` is informational in dnd-kit — by itself it does not stop
// cross-group drops. Forwarding `group` as both `type` and `accept` makes
// each sortable accept only same-group siblings.
//
// `closestCorners` is the recommended detector for sortable lists with
// variable-height items. Default `closestCenter` oscillates when the
// dragged item's placeholder shifts a tall neighbour's center past the
// cursor mid-drag — corner distances stay stable under that re-layout.
const { isDragging } = useSortable({
  id: () => props.id,
  index: () => props.index,
  group: () => props.group,
  type: () => props.group,
  accept: () => props.group,
  collisionDetector: () => props.collisionDetector ?? closestCorners,
  disabled: () => props.disabled ?? false,
  element: el,
});
</script>

<template>
  <component
    :is="(as as any) ?? 'div'"
    ref="el"
    :data-dragging="isDragging || undefined"
  >
    <slot :is-dragging="isDragging" />
  </component>
</template>
