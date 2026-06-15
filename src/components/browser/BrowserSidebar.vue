<script setup lang="ts">
import { ref, computed } from "vue";
import { X } from "@lucide/vue";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { BrowserFavorite, BrowserHistoryItem } from "@/types";

const props = defineProps<{ favorites: BrowserFavorite[]; history: BrowserHistoryItem[] }>();
const emit = defineEmits<{
  navigate: [url: string];
  "open-new-tab": [url: string];
  "remove-favorite": [url: string];
  "rename-favorite": [url: string, title: string];
  "remove-history": [url: string];
  close: [];
}>();

const DAY = 86_400_000;
const groupedHistory = computed(() => {
  const now = Date.now();
  const last7: BrowserHistoryItem[] = [];
  const last30: BrowserHistoryItem[] = [];
  const older: BrowserHistoryItem[] = [];
  for (const h of props.history) {        // store returns newest-first
    const age = now - h.visitedAt;
    if (age < 7 * DAY) last7.push(h);
    else if (age < 30 * DAY) last30.push(h);
    else older.push(h);
  }
  return [
    { key: "7", label: "Last 7 Days", items: last7 },
    { key: "30", label: "Last 30 Days", items: last30 },
    { key: "old", label: "Older", items: older },
  ].filter(g => g.items.length > 0);
});

const renamingUrl = ref<string | null>(null);
const renameValue = ref("");

function startRename(f: BrowserFavorite) {
  renamingUrl.value = f.url;
  renameValue.value = f.title || f.url;
}

function commitRename() {
  const url = renamingUrl.value;
  if (url && renameValue.value.trim()) emit("rename-favorite", url, renameValue.value.trim());
  renamingUrl.value = null;
  renameValue.value = "";
}

function cancelRename() {
  renamingUrl.value = null;
  renameValue.value = "";
}
</script>

<template>
  <div class="absolute inset-x-0 bottom-0 top-8 z-40">
    <div class="absolute inset-0 bg-black/20" @click="emit('close')" />
    <div class="absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-border bg-sidebar shadow-xl">
      <div class="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
        Favorites
      </div>
      <div v-if="!favorites.length" class="px-3 py-1 text-xs text-muted-foreground/60">No favorites yet</div>
      <ContextMenu v-for="f in favorites" :key="`fav:${f.url}`">
        <ContextMenuTrigger as-child>
          <div class="group flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary/50">
            <img v-if="f.faviconUrl" :src="f.faviconUrl" class="size-4 shrink-0" aria-hidden="true" />
            <input
              v-if="renamingUrl === f.url"
              v-model="renameValue"
              v-focus
              class="min-w-0 flex-1 bg-transparent outline-none ring-1 ring-border rounded px-1"
              @click.stop
              @keydown.enter.prevent.stop="commitRename"
              @keydown.escape.prevent.stop="cancelRename"
              @blur="commitRename"
            />
            <button v-else class="min-w-0 flex-1 truncate text-left" @click="emit('navigate', f.url)">{{ f.title || f.url }}</button>
            <span class="opacity-0 group-hover:opacity-100" @click.stop="emit('remove-favorite', f.url)"><X class="size-3.5" /></span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent class="min-w-40">
          <ContextMenuItem @select="emit('navigate', f.url)">Open</ContextMenuItem>
          <ContextMenuItem @select="emit('open-new-tab', f.url)">Open in New Tab</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="startRename(f)">Rename</ContextMenuItem>
          <ContextMenuItem @select="emit('remove-favorite', f.url)">Remove Favorite</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <template v-for="g in groupedHistory" :key="g.key">
          <div class="flex items-center gap-1.5 px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground">{{ g.label }}</div>
          <ContextMenu v-for="h in g.items" :key="`hist:${h.url}:${h.visitedAt}`">
            <ContextMenuTrigger as-child>
              <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary/50" @click="emit('navigate', h.url)">
                <img v-if="h.faviconUrl" :src="h.faviconUrl" class="size-4 shrink-0" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate">{{ h.title || h.url }}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent class="min-w-40">
              <ContextMenuItem @select="emit('navigate', h.url)">Open</ContextMenuItem>
              <ContextMenuItem @select="emit('open-new-tab', h.url)">Open in New Tab</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem @select="emit('remove-history', h.url)">Remove from History</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </template>
        <div v-if="!groupedHistory.length" class="px-3 py-1 text-xs text-muted-foreground/60">No history yet</div>
      </div>
    </div>
  </div>
</template>
