<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRpc } from "@/composables/useRpc";
import { useWorkspaceStore } from "@/stores/workspace";
import { useCommands, type Command } from "@/composables/useCommands";
import FileIcon from "./FileIcon.vue";
import { agentIconSurfaceForTheme, getAgentIconForSurface } from "@/composables/useAgentIcon";
import { useTheme } from "@/composables/useTheme";
import {
  COMMAND_PALETTE_FILTERS,
  commandPaletteShowsActions,
  commandPaletteShowsAgents,
  commandPaletteShowsFiles,
  cycleCommandPaletteFilter,
  isSettingsCommand,
  type CommandPaletteMode,
} from "@/lib/commandPalette";
import {
  CommandDialog,
  CommandList,
  CommandGroup,
  CommandItem,
} from "./ui/command";

const vAutoFocus = { mounted: (el: HTMLElement) => requestAnimationFrame(() => el.focus()) };

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ initialMode?: CommandPaletteMode }>();
const emit = defineEmits<{ openFile: [path: string] }>();

const store = useWorkspaceStore();
const rpc = useRpc();
const { list: commandList } = useCommands();
const { activeThemeName, getActiveThemeSpec } = useTheme();

interface SearchResult {
  name: string;
  path: string;
  relPath: string;
  recent: boolean;
}

const mode = ref<CommandPaletteMode>("search");
const term = ref("");
const results = ref<SearchResult[]>([]);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchGeneration = 0;

const filesVisible = computed(() => commandPaletteShowsFiles(mode.value));
const actionsVisible = computed(() => commandPaletteShowsActions(mode.value));
const agentsVisible = computed(() => commandPaletteShowsAgents(mode.value));

const placeholder = computed(() =>
  mode.value === "all" ? "Search files, actions, agents…"
  : mode.value === "agents" ? "Search agents…"
  : mode.value === "command" ? "Search actions…"
  : mode.value === "settings" ? "Search settings…"
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
  const commands = mode.value === "settings"
    ? commandList().filter((command) => isSettingsCommand(command.id))
    : commandList();
  for (const c of commands) {
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
  if (!agentsVisible.value) return [];
  const q = term.value.toLowerCase().trim();
  const items = store.agentsList("current").map((i) => ({
    tabId: i.tab.id,
    directoryId: i.directory.id,
    title: store.sessionName(i.tab.id),
    agentType: store.tabRuntime.get(i.tab.id)?.agentType ?? i.tab.lastAgentType ?? "claude",
    updatedAt: i.tab.createdAt,
  }));
  if (!q) return items;
  return items.filter((a) => a.title.toLowerCase().includes(q));
});

const agentIconSurface = computed(() => {
  void activeThemeName.value;
  return agentIconSurfaceForTheme(getActiveThemeSpec().type);
});

function agentIcon(type: string): string {
  return getAgentIconForSurface(type, agentIconSurface.value);
}

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
function setMode(nextMode: CommandPaletteMode) {
  searchGeneration++;
  mode.value = nextMode;
  term.value = "";
  results.value = [];
  if (commandPaletteShowsFiles(nextMode)) void doSearch("");
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
  if (e.metaKey && (e.key === "[" || e.key === "]")) {
    e.preventDefault();
    setMode(cycleCommandPaletteFilter(mode.value, e.key === "[" ? -1 : 1));
    return;
  }
  // `>` / `:` at an empty unscoped prompt switch mode instead of typing the char.
  if (term.value === "" && (mode.value === "all" || mode.value === "search")) {
    if (e.key === ">") { e.preventDefault(); setMode("command"); return; }
    if (e.key === ":") { e.preventDefault(); setMode("goto"); return; }
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

function selectAgent(tabId: string) {
  open.value = false;
  store.selectSession(tabId);
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

// Empty query → split into "Recent Files" (frecency>0) + "Files". While typing,
// one ranked "Files" group (FFF already floats recent matches to the top).
const fileGroups = computed<{ heading: string; items: SearchResult[] }[]>(() => {
  if (!results.value.length) return [];
  if (term.value.trim()) return [{ heading: "Files", items: results.value }];
  const recent = results.value.filter((r) => r.recent);
  const rest = results.value.filter((r) => !r.recent);
  const groups: { heading: string; items: SearchResult[] }[] = [];
  if (recent.length) groups.push({ heading: "Recent Files", items: recent });
  if (rest.length) groups.push({ heading: "Files", items: rest });
  return groups;
});

const noResults = computed(() => {
  if (mode.value === "goto") return false;
  const hasCmd = actionsVisible.value && commandGroups.value.length > 0;
  const hasAgents = agentsVisible.value && matchingAgents.value.length > 0;
  const hasFiles = filesVisible.value && results.value.length > 0;
  return !hasCmd && !hasAgents && !hasFiles;
});
</script>

<template>
  <CommandDialog
    v-model:open="open"
    title="Command Palette"
    description="Search files, run actions, jump to a line"
    :ignore-filter="true"
    :show-overlay="true"
    content-class="h-[525px] max-h-[calc(100vh-2rem)] rounded-2xl sm:w-[660px] sm:max-w-[calc(100vw-2rem)]"
  >
    <div ref="rootRef" class="flex h-full min-h-0 flex-col">
      <div class="flex h-14 shrink-0 items-center border-b px-4">
        <input
          ref="inputRef"
          v-auto-focus
          v-model="term"
          :placeholder="placeholder"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          class="h-10 w-full bg-transparent text-base outline-hidden placeholder:text-muted-foreground"
          @keydown="onKeydown"
        />
      </div>
      <div class="flex shrink-0 items-center gap-1 px-3 py-1" role="group" aria-label="Command palette filters">
        <button
          v-for="filter in COMMAND_PALETTE_FILTERS"
          :key="filter.mode"
          type="button"
          class="h-8 rounded-full px-3 text-sm font-medium transition-[color,background-color,scale] duration-150 active:scale-[0.96]"
          :class="mode === filter.mode
            ? 'bg-secondary text-secondary-foreground'
            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'"
          :aria-pressed="mode === filter.mode"
          @click="setMode(filter.mode)"
          @mousedown.prevent
        >
          {{ filter.label }}
        </button>
      </div>
      <CommandList class="min-h-0 max-h-none flex-1">
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

        <template v-if="agentsVisible">
          <CommandGroup v-if="matchingAgents.length" heading="Agents">
            <CommandItem
              v-for="a in matchingAgents"
              :key="a.tabId"
              :value="`agent:${a.title}`"
              @select="selectAgent(a.tabId)"
            >
              <img :src="agentIcon(a.agentType)" class="mr-2 size-4 shrink-0" aria-hidden="true" />
              <span class="truncate text-sm">{{ a.title }}</span>
              <span class="text-xs text-muted-foreground">{{ timeAgo(a.updatedAt) }}</span>
            </CommandItem>
          </CommandGroup>
        </template>
        <template v-if="filesVisible">
          <CommandGroup v-for="g in fileGroups" :key="g.heading" :heading="g.heading">
            <CommandItem
              v-for="r in g.items"
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
      <footer class="flex h-8 shrink-0 items-center gap-4 border-t border-border/60 px-4 text-xs text-muted-foreground/60">
        <span><kbd class="font-sans">↑↓</kbd> Select</span>
        <span><kbd class="font-sans">↵</kbd> Open</span>
        <span><kbd class="font-sans">⌘[</kbd> / <kbd class="font-sans">⌘]</kbd> Change Filter</span>
      </footer>
    </div>
  </CommandDialog>
</template>
