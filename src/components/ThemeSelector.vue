<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useTheme } from "@/composables/useTheme";
import { Check } from "@lucide/vue";

const open = defineModel<boolean>("open", { default: false });
const { activeThemeName, availableThemes, themeTitles, setTheme, previewTheme } = useTheme();

const savedTheme = ref("");
const search = ref("");
const listEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

const filtered = computed(() => {
  const q = search.value.toLowerCase();
  if (!q) return availableThemes.value;
  return availableThemes.value.filter((n) =>
    (themeTitles.value[n] ?? n).toLowerCase().includes(q) || n.toLowerCase().includes(q)
  );
});

let highlightIdx = ref(0);

function syncHighlight() {
  const name = filtered.value[highlightIdx.value];
  if (name) previewTheme(name);
}

watch(open, async (isOpen) => {
  if (isOpen) {
    savedTheme.value = activeThemeName.value;
    search.value = "";
    highlightIdx.value = filtered.value.indexOf(activeThemeName.value);
    if (highlightIdx.value < 0) highlightIdx.value = 0;
    await nextTick();
    focusInput();
  }
});

watch(search, () => {
  highlightIdx.value = 0;
});

function focusInput() {
  inputEl.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightIdx.value = Math.min(highlightIdx.value + 1, filtered.value.length - 1);
    syncHighlight();
    scrollToHighlighted();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightIdx.value = Math.max(highlightIdx.value - 1, 0);
    syncHighlight();
    scrollToHighlighted();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const name = filtered.value[highlightIdx.value];
    if (name) onSelect(name);
  }
}

function scrollToHighlighted() {
  nextTick(() => {
    const el = listEl.value?.querySelector("[data-highlighted]") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  });
}

function onSelect(name: string) {
  savedTheme.value = name;
  setTheme(name);
  open.value = false;
}

function onClose() {
  if (activeThemeName.value !== savedTheme.value) {
    previewTheme(savedTheme.value);
  }
  open.value = false;
}

function onBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).dataset.slot === "backdrop") onClose();
}

function onItemHover(name: string, idx: number) {
  highlightIdx.value = idx;
  previewTheme(name);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-slot="backdrop"
      class="fixed inset-0 z-50"
      @click="onBackdropClick"
      @keydown="onKeydown"
    >
      <div class="mx-auto mt-[10vh] w-full max-w-md rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden">
        <div class="flex h-9 items-center gap-2 border-b px-3">
          <svg class="size-4 shrink-0 opacity-50" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            ref="inputEl"
            v-model="search"
            placeholder="Search themes..."
            class="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground"
          />
        </div>
        <div ref="listEl" class="max-h-[300px] overflow-y-auto p-1">
          <div v-if="filtered.length === 0" class="py-6 text-center text-sm text-muted-foreground">
            No themes found.
          </div>
          <div
            v-for="(name, idx) in filtered"
            :key="name"
            :data-highlighted="idx === highlightIdx ? '' : undefined"
            class="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none"
            :class="idx === highlightIdx ? 'bg-accent text-accent-foreground' : ''"
            @click="onSelect(name)"
            @pointerenter="onItemHover(name, idx)"
          >
            <Check
              class="size-4 shrink-0"
              :class="name === savedTheme ? 'opacity-100' : 'opacity-0'"
            />
            {{ themeTitles[name] ?? name }}
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
