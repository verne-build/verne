<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { Check, ChevronDown, ChevronRight, FolderOpen, FolderPlus, Search } from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useProjectIcons } from "@/composables/useProjectIcons";
import { listen, type UnlistenFn } from "@/platform";
import { partitionSessions, type SessionRow as SessionRowModel } from "@/lib/sessionsView";
import { sortSessionCards, type CardSortInputs } from "@/lib/sessionSort";
import SessionCard from "./SessionCard.vue";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkingDirectory } from "@/types";

const store = useWorkspaceStore();
const { request } = useRpc();
const { icons: projectIcons, transparentIcons: transparentProjectIcons } = useProjectIcons();

const rootDirs = computed(() =>
  store.directories.filter((d) => !d.parentDirectoryId),
);

const activeChip = ref<string>("all"); // dirId of a ROOT, or "all"; resets every launch (not persisted)

// -- workspace filter dropdown --
const workspaceMenuOpen = ref(false);
const workspaceQuery = ref("");
function setWorkspaceMenuOpen(open: boolean): void {
  workspaceMenuOpen.value = open;
  workspaceQuery.value = "";
}
const filteredRootDirs = computed(() => {
  const q = workspaceQuery.value.trim().toLowerCase();
  return q ? rootDirs.value.filter((d) => d.name.toLowerCase().includes(q)) : rootDirs.value;
});
const activeWorkspaceName = computed(() =>
  rootDirs.value.find((d) => d.id === activeChip.value)?.name ?? null,
);
function selectWorkspace(id: string): void {
  activeChip.value = id;
}
function onWorkspaceFilterKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (!workspaceQuery.value) return;
    event.preventDefault();
    event.stopPropagation();
    workspaceQuery.value = "";
    return;
  }
  if (["ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab"].includes(event.key)) return;
  event.stopPropagation();
}

const rootOf = (d: WorkingDirectory): WorkingDirectory =>
  d.parentDirectoryId ? (store.directories.find((x) => x.id === d.parentDirectoryId) ?? d) : d;

const sortInputs = computed<CardSortInputs>(() => ({
  rootNameOf: (dirId) => {
    const d = store.directories.find((x) => x.id === dirId);
    return d ? rootOf(d).name : "";
  },
  worktreeNameOf: (dirId) => {
    const d = store.directories.find((x) => x.id === dirId);
    return d?.parentDirectoryId ? d.name : null;
  },
  activityAt: (tabId) => store.sessionActivityAt.get(tabId) ?? 0,
}));

const liveCards = shallowRef<SessionRowModel[]>([]);
const archivedCards = shallowRef<SessionRowModel[]>([]);
const archivedOpen = ref(false);
const archiveHeightAnimating = ref(false);
let archiveHeightTimer: ReturnType<typeof setTimeout> | undefined;
const sessionsScrollRef = ref<HTMLElement | null>(null);
type SessionListItem =
  | { kind: "session"; key: string; row: SessionRowModel }
  | { kind: "archive-header"; key: "archive-header" };

const sessionListItems = computed<SessionListItem[]>(() => {
  const items: SessionListItem[] = liveCards.value.map((row) => ({
    kind: "session",
    key: `session:${row.tab.id}`,
    row,
  }));
  if (!archivedCards.value.length) return items;
  items.push({ kind: "archive-header", key: "archive-header" });
  if (archivedOpen.value) {
    items.push(...archivedCards.value.map((row) => ({
      kind: "session" as const,
      key: `session:${row.tab.id}`,
      row,
    })));
  }
  return items;
});

const LIVE_ROW_ESTIMATE = 68;
const ARCHIVED_ROW_ESTIMATE = 34;
const ARCHIVE_HEADER_ESTIMATE = 32;
const SESSION_OVERSCAN = 10;

const sessionVirtualizer = useVirtualizer(
  computed(() => ({
    count: sessionListItems.value.length,
    getScrollElement: () => sessionsScrollRef.value,
    estimateSize: (index: number) => {
      const item = sessionListItems.value[index];
      if (!item || item.kind === "archive-header") return ARCHIVE_HEADER_ESTIMATE;
      return item.row.tab.archivedAt != null ? ARCHIVED_ROW_ESTIMATE : LIVE_ROW_ESTIMATE;
    },
    overscan: SESSION_OVERSCAN,
    getItemKey: (index: number) => sessionListItems.value[index]?.key ?? index,
  })),
);

const virtualSessionRows = computed(() =>
  sessionVirtualizer.value.getVirtualItems().flatMap((virtualRow) => {
    const item = sessionListItems.value[virtualRow.index];
    return item ? [{ virtualRow, item }] : [];
  }),
);

function measureSessionRow(element: unknown): void {
  if (element instanceof Element) sessionVirtualizer.value.measureElement(element);
}

watch(archivedOpen, () => {
  archiveHeightAnimating.value = true;
  if (archiveHeightTimer) clearTimeout(archiveHeightTimer);
  archiveHeightTimer = setTimeout(() => {
    archiveHeightAnimating.value = false;
    archiveHeightTimer = undefined;
  }, 200);
});

function recomputeCards() {
  let rows = store.sessionsList("all");
  if (activeChip.value !== "all")
    rows = rows.filter((r) => rootOf(r.directory).id === activeChip.value);
  const { live, archived } = partitionSessions(rows);
  liveCards.value = sortSessionCards(live, sortInputs.value);
  archivedCards.value = archived
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const archivedAtDiff = (b.row.tab.archivedAt ?? 0) - (a.row.tab.archivedAt ?? 0);
      return archivedAtDiff || a.index - b.index;
    })
    .map(({ row }) => row);
}

watch(
  [
    () => store.activityVersion,
    () => store.directories,
    () => store.terminalTabsByDirectory,
    activeChip,
  ],
  recomputeCards,
  { immediate: true },
);

// 30s relative-time tick, paused while the document is hidden (perf guardrail).
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | undefined;
function startNowTimer() {
  stopNowTimer();
  nowTimer = setInterval(() => { if (!document.hidden) now.value = Date.now(); }, 30_000);
}
function stopNowTimer() { if (nowTimer) { clearInterval(nowTimer); nowTimer = undefined; } }
function onVisibility() { if (!document.hidden) now.value = Date.now(); }

// -- branch captions --
const branches = ref(new Map<string, string>());
const branchGenerations = new Map<string, number>();
const pathToId = computed(() => {
  const m = new Map<string, string>();
  for (const d of store.directories) m.set(d.path, d.id);
  return m;
});

async function fetchBranch(d: WorkingDirectory) {
  const generation = (branchGenerations.get(d.id) ?? 0) + 1;
  branchGenerations.set(d.id, generation);
  let branch: string | null = null;
  try {
    branch = await request.gitBranchName({ path: d.path });
  } catch {}
  if (
    branchGenerations.get(d.id) !== generation
    || !store.directories.some((current) => current.id === d.id && current.path === d.path)
  ) return;
  if (branch) branches.value.set(d.id, branch);
  else branches.value.delete(d.id);
  branches.value = new Map(branches.value);
}

// Track which we've already watched + branch-fetched so a change to the
// directory list only processes the delta, not all N every time.
const watched = new Set<string>();
async function refreshAll() {
  await Promise.all(store.directories.map(async (d) => {
    if (watched.has(d.id)) return;
    watched.add(d.id);
    try { await request.gitWatch({ path: d.path }); } catch {}
    await fetchBranch(d);
  }));
  // Prune entries for removed directories so a later re-add re-watches.
  const live = new Set(store.directories.map((d) => d.id));
  for (const id of [...watched]) if (!live.has(id)) watched.delete(id);
}

let unlistenGit: UnlistenFn | null = null;
onMounted(async () => {
  startNowTimer();
  document.addEventListener("visibilitychange", onVisibility);
  await refreshAll();
  unlistenGit = await listen<string>("git-status-changed", (ev) => {
    const id = pathToId.value.get(ev.payload);
    if (!id) return;
    const d = store.directories.find((x) => x.id === id);
    if (d) fetchBranch(d);
  });
});
onUnmounted(() => {
  if (archiveHeightTimer) clearTimeout(archiveHeightTimer);
  stopNowTimer();
  document.removeEventListener("visibilitychange", onVisibility);
  unlistenGit?.();
});

watch(() => store.directories.map((d) => d.id).join(","), () => {
  if (activeChip.value !== "all" && !store.directories.some((d) => d.id === activeChip.value))
    activeChip.value = "all";
  refreshAll();
});
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col">
    <Empty v-if="rootDirs.length === 0" class="mx-2 my-3 gap-3 border border-dashed py-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpen />
        </EmptyMedia>
        <EmptyTitle class="text-xs font-normal text-muted-foreground">No workspaces yet</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button size="xs" variant="secondary" :disabled="store.picking" @click="store.openAndSelectWorkspace()">
          <FolderOpen />
          Open Folder
        </Button>
      </EmptyContent>
    </Empty>
    <template v-else>
    <!-- Workspace filter -->
    <ButtonGroup class="mx-2 my-1.5 w-auto shrink-0">
      <DropdownMenu :open="workspaceMenuOpen" @update:open="setWorkspaceMenuOpen">
        <DropdownMenuTrigger as-child>
          <Button type="button" variant="outline" size="xs" aria-label="Select Workspace"
            class="min-w-0 flex-1 justify-start gap-1.5">
            <img v-if="activeChip !== 'all' && projectIcons[activeChip]" :src="projectIcons[activeChip]" :class="['size-3 rounded-xs ring-1 ring-black/10 dark:ring-white/10', transparentProjectIcons[activeChip] && 'p-0.5']" alt="" />
            <FolderOpen v-else class="size-3.5 text-muted-foreground" />
            <span class="truncate">{{ activeWorkspaceName ?? "All Workspaces" }}</span>
            <ChevronDown class="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-[var(--reka-dropdown-menu-trigger-width)] p-0">
          <div class="border-b p-1.5">
            <div class="relative">
              <Search aria-hidden="true" class="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="workspaceQuery" placeholder="Filter Workspaces…" class="h-7 pl-7 text-xs" @keydown="onWorkspaceFilterKeydown" />
            </div>
          </div>
          <div class="max-h-64 overflow-y-auto p-1">
            <DropdownMenuItem @select="selectWorkspace('all')">
              <FolderOpen class="size-4" />
              <span class="flex-1 truncate">All Workspaces</span>
              <Check :class="['ml-auto size-3.5', activeChip === 'all' ? 'opacity-100' : 'opacity-0']" />
            </DropdownMenuItem>
            <DropdownMenuItem v-for="d in filteredRootDirs" :key="d.id" @select="selectWorkspace(d.id)">
              <img v-if="projectIcons[d.id]" :src="projectIcons[d.id]" :class="['size-4 rounded-xs ring-1 ring-black/10 dark:ring-white/10', transparentProjectIcons[d.id] && 'p-0.5']" alt="" />
              <FolderOpen v-else class="size-4" />
              <span class="flex-1 truncate">{{ d.name }}</span>
              <Check :class="['ml-auto size-3.5', activeChip === d.id ? 'opacity-100' : 'opacity-0']" />
            </DropdownMenuItem>
            <p v-if="!filteredRootDirs.length" class="px-2 py-1.5 text-xs text-muted-foreground">No Workspaces Found</p>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" variant="outline" size="xs" aria-label="Add Workspace"
        class="shrink-0" :disabled="store.picking" @click="store.openAndSelectWorkspace()">
        <FolderPlus class="size-3.5 text-muted-foreground" />
      </Button>
    </ButtonGroup>

    <!-- Unified virtual session list -->
    <Collapsible v-model:open="archivedOpen" class="contents">
      <div ref="sessionsScrollRef" class="min-h-0 flex-1 overflow-y-auto pb-3 pt-1 [scrollbar-gutter:stable]">
        <div v-if="sessionListItems.length === 0 && rootDirs.length" class="flex h-24 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          No sessions — press ⌘T
        </div>
        <div
          v-else
          class="relative w-full overflow-hidden motion-reduce:transition-none"
          :class="archiveHeightAnimating
            ? 'transition-[height] duration-200 ease-[cubic-bezier(0.2,0,0,1)]'
            : ''"
          :style="{ height: `${sessionVirtualizer.getTotalSize()}px` }"
        >
          <div
            v-for="entry in virtualSessionRows"
            :key="entry.item.key"
            :ref="measureSessionRow"
            :data-index="entry.virtualRow.index"
            class="absolute left-0 top-0 flow-root w-full"
            :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
          >
            <SessionCard
              v-if="entry.item.kind === 'session'"
              :row="entry.item.row"
              :branch="branches.get(entry.item.row.directory.id)"
              :root-name="rootOf(entry.item.row.directory).name"
              :root-dir-id="rootOf(entry.item.row.directory).id"
              :is-worktree="!!entry.item.row.directory.parentDirectoryId"
              :now="now"
            />
            <CollapsibleTrigger
              v-else
              class="flex h-8 w-full items-center gap-1 px-3 text-xs font-medium text-muted-foreground/70"
            >
              <span>Archived</span>
              <ChevronRight
                :stroke-width="2.5"
                class="ml-auto size-3 shrink-0 transition-transform"
                :class="{ 'rotate-90': archivedOpen }"
              />
            </CollapsibleTrigger>
          </div>
        </div>
      </div>
    </Collapsible>
    </template>
  </div>
</template>
