<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Command, Search } from "@lucide/vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useShortcuts } from "@/composables/useShortcuts";
import { toDisplayKeys } from "@/lib/shortcuts/binding";
import type { ShortcutCategory } from "@/lib/shortcuts/types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

const shortcuts = useShortcuts();
const query = ref("");

// reset search on open; lazy-load the registry if App.vue hasn't yet.
watch(
  () => props.open,
  (o) => {
    if (!o) return;
    query.value = "";
    if (!shortcuts.loaded) void shortcuts.load();
  },
);

const CATEGORY_ORDER: ShortcutCategory[] = [
  "General", "File", "Edit", "View", "Navigation", "Terminal", "Window",
];

type Row = { name: string; label: string; keys: string[] };
type Group = { name: string; items: Row[] };

const filtered = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase();
  const byCat = new Map<string, Row[]>();
  for (const s of shortcuts.registry.value) {
    if (q && !s.label.toLowerCase().includes(q)) continue;
    // Parametric range: show the full 1–9 span rather than the representative key.
    const keys = s.name === "jump-to-tab"
      ? [...toDisplayKeys(s.binding).slice(0, -1), "1–9"]
      : toDisplayKeys(s.binding);
    const list = byCat.get(s.category) ?? [];
    list.push({ name: s.name, label: s.label, keys });
    byCat.set(s.category, list);
  }
  return CATEGORY_ORDER
    .filter((c) => byCat.has(c))
    .map((c) => ({ name: c, items: byCat.get(c)! }));
});
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="flex h-[80vh] max-h-[80vh] w-[90vw] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl bg-sidebar"
    >
      <DialogHeader class="px-6 pt-6 pb-4">
        <DialogTitle class="flex items-center gap-2">
          <Command class="size-4 text-muted-foreground" />
          Keyboard shortcuts
        </DialogTitle>
      </DialogHeader>

      <div class="px-6">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput v-model="query" placeholder="Search shortcuts…" />
        </InputGroup>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <p v-if="filtered.length === 0" class="py-8 text-center text-sm text-muted-foreground">
          No shortcuts match “{{ query }}”.
        </p>
        <div v-for="group in filtered" :key="group.name" class="mb-6 last:mb-0">
          <h3 class="mb-2 text-xs font-medium text-muted-foreground">{{ group.name }}</h3>
          <div>
            <div
              v-for="s in group.items"
              :key="s.name"
              class="flex items-center justify-between py-1.5 text-sm"
            >
              <span>{{ s.label }}</span>
              <KbdGroup>
                <Kbd v-for="(k, i) in s.keys" :key="i">{{ k }}</Kbd>
              </KbdGroup>
            </div>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
