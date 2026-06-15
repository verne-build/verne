<script setup lang="ts">
// Terminal find widget: query input, N/M count, prev/next, case toggle, close.
// Pure UI — emits intents; the host (GridTerminal) drives TerminalController.
import { ref, watch, nextTick, computed } from 'vue';
import { ChevronUp, ChevronDown, X, CaseSensitive } from '@lucide/vue';

const props = defineProps<{
  query: string;
  caseSensitive: boolean;
  current: number; // active match index (-1 = none)
  total: number;
}>();

const emit = defineEmits<{
  (e: 'update:query', v: string): void;
  (e: 'update:caseSensitive', v: boolean): void;
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'close'): void;
}>();

const input = ref<HTMLInputElement | null>(null);

function focus(): void {
  input.value?.focus();
  input.value?.select();
}
defineExpose({ focus });

// Focus on mount (the host toggles the box with v-if).
watch(input, (el) => { if (el) void nextTick(focus); }, { immediate: true });

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? emit('prev') : emit('next'); }
  else if (e.key === 'Escape') { e.preventDefault(); emit('close'); }
}

const countLabel = computed(() => (props.total === 0 ? 'No results' : `${props.current + 1}/${props.total}`));
</script>

<template>
  <div
    class="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-popover/95 px-1.5 py-1 text-xs shadow-md backdrop-blur"
    @mousedown.stop
    @wheel.stop
  >
    <input
      ref="input"
      :value="query"
      class="w-44 bg-transparent px-1 py-0.5 text-foreground outline-none placeholder:text-muted-foreground"
      placeholder="Find"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      aria-label="Find in terminal"
      @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      @keydown="onKeydown"
    />
    <span class="min-w-14 select-none text-right tabular-nums text-muted-foreground">{{ countLabel }}</span>
    <button
      class="rounded p-0.5 hover:bg-accent"
      :class="caseSensitive ? 'bg-accent text-foreground' : 'text-muted-foreground'"
      title="Match Case"
      aria-label="Match case"
      @click="emit('update:caseSensitive', !caseSensitive)"
    >
      <CaseSensitive class="size-3.5" />
    </button>
    <button
      class="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-40"
      :disabled="total === 0"
      title="Previous Match"
      aria-label="Previous match"
      @click="emit('prev')"
    >
      <ChevronUp class="size-3.5" />
    </button>
    <button
      class="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-40"
      :disabled="total === 0"
      title="Next Match"
      aria-label="Next match"
      @click="emit('next')"
    >
      <ChevronDown class="size-3.5" />
    </button>
    <button
      class="rounded p-0.5 text-muted-foreground hover:bg-accent"
      title="Close"
      aria-label="Close find"
      @click="emit('close')"
    >
      <X class="size-3.5" />
    </button>
  </div>
</template>
