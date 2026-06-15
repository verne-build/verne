<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRpc } from "@/composables/useRpc";
import { useWorkspaceStore } from "@/stores/workspace";
import { useCommands, type Command } from "@/composables/useCommands";
import FileIcon from "./FileIcon.vue";
import { getAgentIcon } from "@/composables/useAgentIcon";
import { X } from "@lucide/vue";
import {
  CommandDialog,
  CommandList,
  CommandGroup,
  CommandItem,
} from "./ui/command";

const vAutoFocus = { mounted: (el: HTMLElement) => requestAnimationFrame(() => el.focus()) };

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ initialMode?: Mode }>();
const emit = defineEmits<{ openFile: [path: string] }>();

const store = useWorkspaceStore();
const rpc = useRpc();
const { list: commandList } = useCommands();

interface SearchResult {
  name: string;
  path: string;
  relPath: string;
}

// `all` is the unified palette (⌘K) — no pill, searches files + actions together.
// The other modes are scoped and shown as a deletable pill; Backspace at an
// empty prompt pops any pill back to `all`. `term` is only the filter text.
type Mode = "all" | "search" | "command" | "goto";
const mode = ref<Mode>("search");
const term = ref("");
const results = ref<SearchResult[]>([]);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchGeneration = 0;

const filesVisible = computed(() => mode.value === "search" || mode.value === "all");
const actionsVisible = computed(() => mode.value === "command" || mode.value === "all");

const MODE_LABELS: Partial<Record<Mode, string>> = { search: "Files", command: "Actions", goto: "Go to Line" };
const placeholder = computed(() =>
  mode.value === "all" ? "Search files, actions, agents…"
  : mode.value === "command" ? "Search actions…"
  : mode.value === "goto" ? "Go to line…"
  : "Search files…",
);

// Subsequence fuzzy match — cheap for the small static command set.
function fuzzy(needle: string, haystack: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of needle.toLowerCase()) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

const commandGroups = computed<{ category: string; items: Command[] }[]>(() => {
  if (!actionsVisible.value) return [];
  const t = term.value.trim();
  // In the unified `all` view, only surface actions once the user types — an
  // empty ⌘K shouldn't be a wall of every command.
  if (mode.value === "all" && !t) return [];
  const groups: { category: string; items: Command[] }[] = [];
  for (const c of commandList()) {
    if (c.when && !c.when()) continue;
    if (t && !fuzzy(t, `${c.title} ${c.keywords ?? ""}`)) continue;
    let g = groups.find((x) => x.category === c.category);
    if (!g) { g = { category: c.category, items: [] }; groups.push(g); }
    g.items.push(c);
  }
  return groups;
});

const gotoLine = computed<number | null>(() => {
  if (mode.value !== "goto") return null;
  const n = parseInt(term.value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
});

const matchingAgents = computed(() => {
  if (!filesVisible.value) return [];
  const q = term.value.toLowerCase().trim();
  const items = store.agentsList("current").map((i) => ({
    tabId: i.tab.id,
    directoryId: i.directory.id,
    title: i.tab.label,
    agentType: store.tabRuntime.get(i.tab.id)?.agentType ?? i.tab.lastAgentType ?? "claude",
    updatedAt: i.tab.createdAt,
  }));
  if (!q) return items;
  return items.filter((a) => a.title.toLowerCase().includes(q));
});

async function doSearch(q: string) {
  const generation = ++searchGeneration;
  const root = store.activeRoot;
  const dir = root?.path;
  const directoryId = root?.scopeId;
  if (!dir || !directoryId) {
    results.value = [];
    return;
  }
  try {
    const res = await rpc.request.searchFiles({ dir, query: q, directoryId });
    if (
      generation !== searchGeneration ||
      q !== term.value.trim() ||
      dir !== store.activeRoot?.path ||
      directoryId !== store.activeRoot?.scopeId ||
      !filesVisible.value
    ) return;
    results.value = res.results;
  } catch {
    if (generation !== searchGeneration) return;
    results.value = [];
  }
  // highlightFirst runs via the results watcher below — don't double-fire it here.
}

watch(term, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!filesVisible.value) { highlightFirst(); return; }
  const trimmed = q.trim();
  // Short debounce — just enough to coalesce a burst of keystrokes. The search is
  // cheap (cached list, allocation-free fuzzy), so 150ms felt like a perceived lag
  // floor; 40ms keeps it snappy without firing on every char mid-burst.
  debounceTimer = setTimeout(() => doSearch(trimmed), trimmed ? 40 : 25);
});

// Switch mode, reset the filter text, and refresh the list.
function setMode(m: Mode) {
  mode.value = m;
  term.value = "";
  results.value = [];
  if (m === "search" || m === "all") doSearch("");
  else highlightFirst();
}

watch(open, (isOpen) => {
  if (isOpen) setMode(props.initialMode ?? "search");
});

// Re-highlight first item whenever the rendered list changes
watch([results, matchingAgents, commandGroups], () => highlightFirst());

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  searchGeneration++;
});

const inputRef = ref<HTMLInputElement | null>(null);
const rootRef = ref<HTMLElement | null>(null);

function getListbox() {
  return rootRef.value?.querySelector("[data-slot=command] [role=listbox]") ?? null;
}

function onKeydown(e: KeyboardEvent) {
  // `>` / `:` at an empty unscoped prompt switch mode instead of typing the char.
  if (term.value === "" && (mode.value === "all" || mode.value === "search")) {
    if (e.key === ">") { e.preventDefault(); setMode("command"); return; }
    if (e.key === ":") { e.preventDefault(); setMode("goto"); return; }
  }
  // Backspace at an empty prompt pops the pill back to the unified palette.
  if (e.key === "Backspace" && term.value === "" && mode.value !== "all") {
    e.preventDefault();
    setMode("all");
    return;
  }
  // Go-to-line has no list — execute on Enter directly.
  if (mode.value === "goto" && e.key === "Enter") {
    e.preventDefault();
    if (gotoLine.value !== null) {
      open.value = false;
      window.dispatchEvent(new CustomEvent("editor-goto-line", { detail: gotoLine.value }));
    }
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(e.key)) return;
  const listbox = getListbox();
  if (!listbox) return;
  e.preventDefault();
  listbox.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true }));
  // Refocus input after reka-ui moves focus to highlighted item
  if (e.key !== "Enter") requestAnimationFrame(() => inputRef.value?.focus());
}

function highlightFirst() {
  // Double nextTick: first waits for Vue reactivity, second for DOM render
  nextTick(() => nextTick(() => {
    const listbox = getListbox();
    if (!listbox) return;
    // Clear existing highlight by dispatching Home key, then ArrowDown to first item
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    // Refocus input since reka-ui moves focus to highlighted item
    requestAnimationFrame(() => inputRef.value?.focus());
  }));
}

function selectFile(path: string) {
  open.value = false;
  emit("openFile", path);
}

function selectCommand(cmd: Command) {
  open.value = false;
  void cmd.run();
}

function selectAgent(tabId: string, directoryId: string) {
  open.value = false;
  const dir = store.directories.find((d) => d.id === directoryId) ?? null;
  store.selectDirectory(dir);
  store.setActiveTab(directoryId, tabId);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

const noResults = computed(() => {
  if (mode.value === "goto") return false;
  const hasCmd = actionsVisible.value && commandGroups.value.length > 0;
  const hasFiles = filesVisible.value && (matchingAgents.value.length > 0 || results.value.length > 0);
  return !hasCmd && !hasFiles;
});
</script>

<template>
  <CommandDialog
    v-model:open="open"
    title="Command Palette"
    description="Search files, run actions, jump to a line"
    :ignore-filter="true"
    :show-overlay="true"
  >
    <div ref="rootRef">
    <div class="flex h-11 items-center gap-2 px-3 border-b">
      <button
        v-if="mode !== 'all'"
        type="button"
        class="group inline-flex shrink-0 items-center gap-1 rounded-md bg-secondary py-0.5 pl-2 pr-1 text-xs font-medium text-secondary-foreground"
        tabindex="-1"
        @click="setMode('all')"
        @mousedown.prevent
      >
        {{ MODE_LABELS[mode] }}
        <X class="size-3 opacity-50 group-hover:opacity-100" />
      </button>
      <input
        ref="inputRef"
        v-auto-focus
        v-model="term"
        :placeholder="placeholder"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        class="placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden"
        @keydown="onKeydown"
      />
    </div>
    <CommandList class="h-[300px]">
      <div v-if="noResults" class="py-6 text-center text-sm text-muted-foreground">No results found.</div>

      <!-- Go to line -->
      <div v-if="mode === 'goto'" class="px-3 py-6 text-center text-sm text-muted-foreground">
        <template v-if="gotoLine !== null">Press <kbd class="font-mono">⏎</kbd> to go to line {{ gotoLine }}</template>
        <template v-else>Type a line number</template>
      </div>

      <!-- Actions (ranked above files in the unified palette) -->
      <template v-if="actionsVisible">
        <CommandGroup v-for="g in commandGroups" :key="g.category" :heading="g.category">
          <CommandItem
            v-for="c in g.items"
            :key="c.id"
            :value="`cmd:${c.id}`"
            @select="selectCommand(c)"
          >
            <component :is="c.icon" class="mr-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="truncate text-sm">{{ c.title }}</span>
            <span v-if="c.shortcut" class="ml-auto text-xs tracking-wide text-muted-foreground">{{ c.shortcut }}</span>
          </CommandItem>
        </CommandGroup>
      </template>

      <!-- Files + agents -->
      <template v-if="filesVisible">
        <CommandGroup v-if="matchingAgents.length" heading="Agents">
          <CommandItem
            v-for="a in matchingAgents"
            :key="a.tabId"
            :value="`agent:${a.title}`"
            @select="selectAgent(a.tabId, a.directoryId)"
          >
            <img :src="getAgentIcon(a.agentType)" class="mr-2 size-4 shrink-0" aria-hidden="true" />
            <span class="truncate text-sm">{{ a.title }}</span>
            <span class="text-xs text-muted-foreground">{{ timeAgo(a.updatedAt) }}</span>
          </CommandItem>
        </CommandGroup>
        <CommandGroup v-if="results.length" heading="Files">
          <CommandItem
            v-for="r in results"
            :key="r.path"
            :value="r.relPath"
            @select="selectFile(r.path)"
          >
            <FileIcon :name="r.name" :size="16" class="mr-2" />
            <div class="flex items-center justify-between gap-2 min-w-0">
              <span class="truncate text-sm">{{ r.name }}</span>
              <span class="truncate text-xs text-muted-foreground">{{ r.relPath }}</span>
            </div>
          </CommandItem>
        </CommandGroup>
      </template>
    </CommandList>
    </div>
  </CommandDialog>
</template>
