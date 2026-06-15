<script setup lang="ts">
import { computed, watch, onBeforeUnmount, onMounted, toRef } from "vue";
import { CaseSensitive, CopyMinus, CopyPlus, SlidersHorizontal } from "@lucide/vue";
import { useRpc, type ContentSearchMatch } from "@/composables/useRpc";
import { searchMatchKey, useSearchPanelState } from "@/composables/useSearchPanelState";
import FileIcon from "./FileIcon.vue";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const props = defineProps<{ scopeKey: string; rootDir: string }>();

const scopeKeyRef = toRef(props, "scopeKey");
const {
  query,
  caseSensitive,
  include,
  exclude,
  showOptions,
  results,
  truncated,
  selected,
  searching,
  isFileCollapsed,
  toggleFileCollapsed,
  resetCollapsedFiles,
} = useSearchPanelState(scopeKeyRef);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

interface FileGroup {
  relPath: string;
  name: string;
  dir: string;
  matches: ContentSearchMatch[];
}

const groupedResults = computed((): FileGroup[] => {
  const map = new Map<string, FileGroup>();
  for (const m of results.value) {
    let g = map.get(m.relPath);
    if (!g) {
      const i = m.relPath.lastIndexOf("/");
      g = {
        relPath: m.relPath,
        name: m.name,
        dir: i >= 0 ? m.relPath.slice(0, i) : "",
        matches: [],
      };
      map.set(m.relPath, g);
    }
    g.matches.push(m);
  }
  return [...map.values()];
});

const totalMatches = computed(() => results.value.length);
const showResultsBar = computed(() => query.value.trim() || searching.value || groupedResults.value.length > 0);
const allResultsCollapsed = computed(() =>
  groupedResults.value.length > 0 && groupedResults.value.every(group => isFileCollapsed(group.relPath)),
);

function toggleAllResults() {
  const expanding = allResultsCollapsed.value;
  for (const group of groupedResults.value) {
    if (isFileCollapsed(group.relPath) === expanding) {
      toggleFileCollapsed(group.relPath);
    }
  }
}

async function runSearch() {
  const q = query.value;
  if (!q.trim()) {
    results.value = [];
    truncated.value = false;
    selected.value = null;
    return;
  }

  const snap = q;
  searching.value = true;
  try {
    const out = await useRpc().request.searchContent({
      dir: props.rootDir,
      query: snap,
      caseSensitive: caseSensitive.value,
      include: include.value,
      exclude: exclude.value,
    });
    if (query.value !== snap) return;
    resetCollapsedFiles();
    results.value = out.results;
    truncated.value = out.truncated;
    if (!selected.value || !out.results.some(m => searchMatchKey(m) === searchMatchKey(selected.value!))) {
      selected.value = out.results[0] ?? null;
    }
  } catch (err) {
    console.warn("[SearchPanel] search_content failed:", err);
    if (query.value === snap) {
      results.value = [];
      truncated.value = false;
      selected.value = null;
    }
  } finally {
    if (query.value === snap) searching.value = false;
  }
}

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSearch();
  }, 180);
}

watch([query, caseSensitive, include, exclude], scheduleSearch);

// Re-run when switching workspace scope with a persisted query but no cached results.
watch(() => props.scopeKey, () => {
  if (query.value.trim() && results.value.length === 0) scheduleSearch();
});

onMounted(() => {
  if (query.value.trim() && results.value.length === 0) scheduleSearch();
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-sidebar">
      <div class="min-w-0 shrink-0 bg-sidebar p-2">
        <div class="relative">
          <Input
            v-model="query"
            placeholder="Search"
            class="h-7 w-full pr-14 text-[11px] md:text-[11px] dark:bg-[var(--editor-bg)]"
            spellcheck="false"
          />
          <div class="absolute inset-y-0 right-1 flex items-center gap-0.5">
            <Button
              size="icon-xs"
              :variant="caseSensitive ? 'secondary' : 'ghost'"
              class="size-5"
              aria-label="Match Case"
              @click="caseSensitive = !caseSensitive"
            >
              <CaseSensitive class="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              :variant="showOptions ? 'secondary' : 'ghost'"
              class="size-5"
              aria-label="Search Options"
              @click="showOptions = !showOptions"
            >
              <SlidersHorizontal class="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
      <div v-if="showOptions" class="flex min-w-0 shrink-0 flex-col gap-1.5 bg-sidebar p-2">
        <Input
          v-model="include"
          placeholder="Files to include (e.g. *.ts, src/**)"
          class="h-7 text-[11px] md:text-[11px] dark:bg-[var(--editor-bg)]"
          spellcheck="false"
        />
        <Input
          v-model="exclude"
          placeholder="Files to exclude (e.g. **/*.test.ts)"
          class="h-7 text-[11px] md:text-[11px] dark:bg-[var(--editor-bg)]"
          spellcheck="false"
        />
      </div>
      <div v-if="showResultsBar" class="flex h-7 min-w-0 shrink-0 items-center justify-between gap-2 bg-sidebar px-2">
        <span class="min-w-0 truncate text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Results · {{ totalMatches }}{{ truncated ? "+" : "" }}
          <span v-if="searching" class="normal-case">…</span>
        </span>
        <TooltipProvider :delay-duration="1000">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                size="icon-xs"
                variant="ghost"
                class="text-muted-foreground hover:text-foreground"
                :disabled="groupedResults.length === 0"
                :aria-label="allResultsCollapsed ? 'Expand All' : 'Collapse All'"
                @click="toggleAllResults"
              >
                <CopyPlus
                  v-if="allResultsCollapsed"
                  class="size-3.5 -scale-x-100"
                />
                <CopyMinus
                  v-else
                  class="size-3.5 -scale-x-100"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{{ allResultsCollapsed ? "Expand All" : "Collapse All" }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-sidebar">
        <template v-if="groupedResults.length">
          <div v-for="group in groupedResults" :key="group.relPath" class="mb-0.5">
            <button
              type="button"
              class="grid w-full min-w-0 grid-cols-[12px_16px_minmax(0,1fr)_auto] items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-[color-mix(in_oklch,var(--color-border)_20%,transparent)]"
              :aria-label="isFileCollapsed(group.relPath) ? `Expand ${group.name}` : `Collapse ${group.name}`"
              @click="toggleFileCollapsed(group.relPath)"
            >
              <span class="flex size-3 items-center justify-center text-muted-foreground">
                <span
                  class="block size-0 border-l-[5px] border-l-current border-y-[3.5px] border-y-transparent transition-transform"
                  :class="{ 'rotate-90': !isFileCollapsed(group.relPath) }"
                />
              </span>
              <FileIcon :name="group.name" :size="16" class="shrink-0" />
              <span class="flex min-w-0 items-baseline gap-1.5">
                <span class="min-w-0 truncate font-medium text-foreground">{{ group.name }}</span>
                <span v-if="group.dir" class="min-w-0 truncate text-muted-foreground">{{ group.dir }}</span>
              </span>
              <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{{ group.matches.length }}</span>
            </button>
            <template v-if="!isFileCollapsed(group.relPath)">
              <button
                v-for="m in group.matches"
                :key="searchMatchKey(m)"
                type="button"
                class="block w-full overflow-hidden py-0.5 pl-[26px] pr-2 text-left text-xs text-muted-foreground"
                :class="selected && searchMatchKey(selected) === searchMatchKey(m)
                  ? 'bg-[var(--color-tab-active-bg)] text-[var(--color-foreground)] hover:bg-[var(--color-tab-active-bg)]'
                  : 'hover:bg-[color-mix(in_oklch,var(--color-border)_25%,transparent)]'"
                @click="selected = m"
              >
                <span class="flex min-w-0 max-w-full items-baseline overflow-hidden font-mono">
                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right [direction:rtl]">
                    <span class="[direction:ltr]">{{ m.pre }}</span>
                  </span>
                  <mark class="mx-px shrink-0 rounded-[1px] bg-yellow-400/30 text-foreground">{{ m.match }}</mark>
                  <span class="min-w-0 flex-1 truncate">{{ m.post }}</span>
                </span>
              </button>
            </template>
          </div>
        </template>
        <div v-else-if="query.trim() && !searching" class="px-2 py-4 text-xs text-muted-foreground">
          No results
        </div>
      </div>
  </div>
</template>
