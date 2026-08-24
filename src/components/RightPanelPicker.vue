<script setup lang="ts">
import { computed, ref } from "vue";
import type { OpenableTabKind } from "@/types";
import { TAB_TYPE_ENTRIES } from "@/lib/rightPanelTabTypes";
import { useShortcuts } from "@/composables/useShortcuts";
import { Item, ItemActions, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";

const emit = defineEmits<{ open: [kind: OpenableTabKind] }>();
const shortcuts = useShortcuts();
const listEl = ref<HTMLElement | null>(null);
const rows = computed(() => TAB_TYPE_ENTRIES.map((entry) => {
  const shortcut = "shortcut" in entry ? entry.shortcut : undefined;
  return {
    ...entry,
    shortcutText: shortcut ? shortcuts.displayKeys(shortcut).join("") : "",
  };
}));

function moveFocus(index: number, delta: -1 | 1) {
  const buttons = listEl.value?.querySelectorAll<HTMLButtonElement>("[data-picker-row]");
  if (!buttons) return;
  const count = TAB_TYPE_ENTRIES.length;
  buttons[(index + delta + count) % count]?.focus();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 items-center justify-center bg-sidebar px-6 py-10">
    <div ref="listEl" class="flex w-full max-w-[440px] flex-col gap-1">
      <Item
        v-for="(entry, index) in rows"
        :key="entry.kind"
        as="button"
        type="button"
        data-picker-row
        variant="muted"
        class="grid h-11 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 rounded-lg bg-muted/50 px-4 py-0 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
        @click="emit('open', entry.kind)"
        @keydown.up.prevent="moveFocus(index, -1)"
        @keydown.down.prevent="moveFocus(index, 1)"
      >
        <ItemMedia class="size-4"><component :is="entry.icon" class="size-3.5 text-muted-foreground" /></ItemMedia>
        <ItemTitle class="h-5 leading-5">{{ entry.label }}</ItemTitle>
        <ItemActions v-if="entry.shortcutText" class="h-5">
          <Kbd>{{ entry.shortcutText }}</Kbd>
        </ItemActions>
      </Item>
    </div>
  </div>
</template>
