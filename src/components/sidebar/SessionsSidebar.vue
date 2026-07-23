<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { FolderOpen, Plus } from "@lucide/vue";
import { ask } from "@/platform";
import StatusIndicator from "@/components/StatusIndicator.vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useProjectIcons } from "@/composables/useProjectIcons";
import { listen, type UnlistenFn } from "@/platform";
import { aggregateGroupState, resolveDisplayState, stripSpinner } from "@/lib/agentStatus";
import type { DisplayState } from "@/lib/agentStatus";
import type { SessionRow as SessionRowModel } from "@/lib/sessionsView";
import { sortSessionCards, type CardSortInputs } from "@/lib/sessionSort";
import SessionCard from "./SessionCard.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useScrollFades } from "@/composables/useScrollFades";
import type { WorkingDirectory } from "@/types";

const store = useWorkspaceStore();
const { request } = useRpc();
const { icons: projectIcons } = useProjectIcons();

// top/bottom content fades against the fixed header
const { bodyEl, atStart, atEnd, update } = useScrollFades();
const {
  bodyEl: chipRailEl,
  atStart: chipRailAtStart,
  atEnd: chipRailAtEnd,
  update: updateChipRail,
} = useScrollFades("horizontal");

const rootDirs = computed(() =>
  store.directories.filter((d) => !d.parentDirectoryId),
);
const worktreesByParent = computed(() => {
  const map = new Map<string, WorkingDirectory[]>();
  for (const d of store.directories) {
    if (!d.parentDirectoryId) continue;
    const list = map.get(d.parentDirectoryId);
    if (list) list.push(d);
    else map.set(d.parentDirectoryId, [d]);
  }
  return map;
});

// -- filter --
const query = ref("");
function matches(r: SessionRowModel): boolean {
  const q = query.value.toLowerCase();
  return (
    stripSpinner(store.sessionName(r.tab.id)).toLowerCase().includes(q) ||
    (r.agentType ?? "").toLowerCase().includes(q) ||
    r.directory.name.toLowerCase().includes(q)
  );
}

const activeChip = ref<string>("all"); // dirId of a ROOT, or "all"; resets every launch (not persisted)

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

const cards = shallowRef<SessionRowModel[]>([]);
function recomputeCards() {
  let rows = store.sessionsList("all");
  if (activeChip.value !== "all")
    rows = rows.filter((r) => rootOf(r.directory).id === activeChip.value);
  if (query.value) rows = rows.filter(matches); // existing matches()
  cards.value = sortSessionCards(rows, sortInputs.value);
}

watch(
  [
    () => store.activityVersion,
    () => store.directories,
    () => store.terminalTabsByDirectory,
    query,
    activeChip,
  ],
  recomputeCards,
  { immediate: true },
);

// Chip aggregate dot: any blocked/working session under the root INCLUDING worktrees.
const chipStates = computed(() => {
  const byRoot = new Map<string, ReturnType<typeof resolveDisplayState>[]>();
  for (const r of store.sessionsList("all")) {
    const rid = rootOf(r.directory).id;
    const rt = store.tabRuntime.get(r.tab.id);
    const s = resolveDisplayState({
      needsAcknowledgement: rt?.needsAcknowledgement,
      agentType: r.agentType,
      agentState: rt?.agentState ?? r.tab.lastAgentState,
      requireAgentType: true,
    });
    (byRoot.get(rid) ?? byRoot.set(rid, []).get(rid)!).push(s);
  }
  const out = new Map<string, DisplayState | null>();
  for (const [rid, states] of byRoot) {
    const agg = aggregateGroupState(states);
    out.set(rid, agg === "blocked" || agg === "working" ? agg : null);
  }
  return out;
});

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
  stopNowTimer();
  document.removeEventListener("visibilitychange", onVisibility);
  unlistenGit?.();
});

watch(() => store.directories.map((d) => d.id).join(","), () => {
  if (activeChip.value !== "all" && !store.directories.some((d) => d.id === activeChip.value))
    activeChip.value = "all";
  refreshAll();
  nextTick(update);
  nextTick(updateChipRail);
});
// row count changes (new/closed sessions, filter) move the scroll extents
const sessionCount = computed(() =>
  Object.values(store.terminalTabsByDirectory).reduce((count, tabs) => count + tabs.length, 0),
);
watch([sessionCount, query], () => nextTick(update));

function select(d: WorkingDirectory) {
  store.selectDirectory(d);
  void store.loadTabsForDirectory(d.id);
}

function onNewSession(d: WorkingDirectory) {
  if (store.selectedDirectoryId !== d.id) select(d);
  void store.newSession(d.id).catch((e) => window.alert(`Failed to create session: ${e}`));
}

async function onCreateWorktree(parentDirId: string) {
  try {
    const dir = await store.createWorktree(parentDirId, "");
    store.selectDirectory(dir);
    try { await store.createTab({ directoryId: dir.id }); } catch {}
    void store.loadTabsForDirectory(dir.id);
  } catch (e) {
    window.alert(`Failed to create worktree: ${e}`);
  }
}

async function onRemoveWorktree(dirId: string) {
  const ok = await ask("Delete this worktree? This runs `git worktree remove`.", {
    title: "Delete worktree",
    kind: "warning",
  });
  if (!ok) return;
  try {
    await store.removeWorktree(dirId);
  } catch (e) {
    window.alert(`Failed to delete worktree: ${e}`);
  }
}

const renamingId = ref<string | null>(null);
const renameInputEl = ref<HTMLInputElement | null>(null);

function startRenameWorktree(dirId: string) {
  renamingId.value = dirId;
}

async function finishRenameWorktree(dirId: string, value: string) {
  if (renamingId.value !== dirId) return;
  renamingId.value = null;
  renameInputEl.value = null;
  const trimmed = value.trim();
  const current = store.directories.find((d) => d.id === dirId)?.name ?? "";
  if (!trimmed || trimmed === current) return;
  try {
    await store.renameWorktree(dirId, trimmed);
  } catch (e) {
    window.alert(`Failed to rename worktree: ${e}`);
  }
}

function cancelRenameWorktree() {
  renamingId.value = null;
  renameInputEl.value = null;
}

function onRenameInputMounted(el: unknown) {
  if (!(el instanceof HTMLInputElement)) return;
  renameInputEl.value = el;
  requestAnimationFrame(() => {
    if (renameInputEl.value !== el) return;
    el.focus();
    el.select();
  });
}

function onWorktreeMenuCloseAutoFocus(e: Event) {
  // Started a rename from the context menu: keep focus on the rename input.
  // Otherwise reka-ui returns focus to the trigger button, blurring the input
  // and cancelling the rename before any typing (flash-then-revert bug).
  if (renamingId.value) e.preventDefault();
}

function onDocMousedown(e: MouseEvent) {
  const id = renamingId.value;
  const el = renameInputEl.value;
  if (!id || !el) return;
  const target = e.target as Node | null;
  if (target && (target === el || el.contains(target))) return;
  finishRenameWorktree(id, el.value);
}

onMounted(() => document.addEventListener("mousedown", onDocMousedown, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMousedown, true));

async function onRemoveDirectory(dirId: string) {
  const dir = store.directories.find((d) => d.id === dirId);
  const label = dir?.name ?? "this workspace";
  const ok = await ask(`Remove ${label} from the sidebar? The folder on disk is left alone.`, {
    title: "Remove workspace",
    kind: "warning",
  });
  if (!ok) return;
  try {
    await store.deleteDirectory(dirId);
  } catch (e) {
    window.alert(`Failed to remove workspace: ${e}`);
  }
}
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col">
    <div class="flex h-7 shrink-0 items-center gap-1.5 pl-3 pr-1.5">
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground/70">Sessions</div>
      <input
        v-model="query"
        type="text"
        placeholder="Filter"
        class="h-5 min-w-0 flex-1 rounded-sm bg-transparent px-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:bg-input/30"
      />
    </div>
    <div
      class="pointer-events-none absolute inset-x-0 top-7 z-10 h-4 bg-linear-to-b from-sidebar to-transparent transition-opacity"
      :class="atStart ? 'opacity-0' : 'opacity-100'"
    />
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4 bg-linear-to-t from-sidebar to-transparent transition-opacity"
      :class="atEnd ? 'opacity-0' : 'opacity-100'"
    />
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
    <!-- Chip rail -->
    <div class="relative flex shrink-0 items-center gap-1.5 pr-2">
    <div class="relative min-w-0 flex-1">
      <div
        ref="chipRailEl"
        class="flex items-center gap-1.5 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        @scroll="updateChipRail"
      >
      <Badge as="button" type="button" :variant="activeChip === 'all' ? 'default' : 'outline'"
        class="cursor-pointer select-none shrink-0" @click="activeChip = 'all'">All</Badge>
      <ContextMenu v-for="d in rootDirs" :key="d.id">
        <ContextMenuTrigger as-child>
          <Badge as="button" type="button" :variant="activeChip === d.id ? 'default' : 'outline'"
            class="cursor-pointer select-none shrink-0 gap-1" @click="activeChip = d.id">
            <img v-if="projectIcons[d.id]" :src="projectIcons[d.id]" class="size-3 rounded-sm" alt="" />
            {{ d.name }}
            <StatusIndicator v-if="chipStates.get(d.id)" :state="chipStates.get(d.id)!" class="size-2.5" />
          </Badge>
        </ContextMenuTrigger>
        <ContextMenuContent @close-auto-focus="onWorktreeMenuCloseAutoFocus">
          <ContextMenuItem @select="onNewSession(d)">New Session</ContextMenuItem>
          <ContextMenuItem @select="onCreateWorktree(d.id)">New Worktree</ContextMenuItem>
          <ContextMenuSub v-if="(worktreesByParent.get(d.id) ?? []).length">
            <ContextMenuSubTrigger>Worktrees</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <template v-for="wt in worktreesByParent.get(d.id)" :key="wt.id">
                <ContextMenuItem @select="startRenameWorktree(wt.id)">Rename {{ wt.name }}…</ContextMenuItem>
                <ContextMenuItem variant="destructive" @select="onRemoveWorktree(wt.id)">Delete {{ wt.name }}</ContextMenuItem>
              </template>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" @select="onRemoveDirectory(d.id)">Remove Workspace</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      </div>
      <div
        class="pointer-events-none absolute inset-y-0 left-0 z-10 w-4 bg-linear-to-r from-sidebar to-transparent transition-opacity"
        :class="chipRailAtStart ? 'opacity-0' : 'opacity-100'"
      />
      <div
        class="pointer-events-none absolute inset-y-0 right-0 z-10 w-4 bg-linear-to-l from-sidebar to-transparent transition-opacity"
        :class="chipRailAtEnd ? 'opacity-0' : 'opacity-100'"
      />
    </div>
    <Badge as="button" type="button" variant="outline" aria-label="Add Workspace"
      class="cursor-pointer select-none shrink-0 disabled:pointer-events-none disabled:opacity-50"
      :disabled="store.picking" @click="store.openAndSelectWorkspace()">
      <Plus class="size-3" />
    </Badge>
    </div>

    <div v-if="renamingId" class="px-3 py-1.5 border-b flex items-center gap-2">
      <span class="text-xs text-muted-foreground shrink-0">Rename worktree:</span>
      <input :ref="onRenameInputMounted" class="h-6 flex-1 rounded border bg-transparent px-1.5 text-xs"
        :value="store.directories.find((d) => d.id === renamingId)?.name"
        @keydown.enter="finishRenameWorktree(renamingId!, ($event.target as HTMLInputElement).value)"
        @blur="renamingId && finishRenameWorktree(renamingId, ($event.target as HTMLInputElement).value)"
        @keydown.escape="cancelRenameWorktree" />
    </div>

    <!-- Card list -->
    <div ref="bodyEl" class="app-scrollbar min-h-0 flex-1 overflow-y-auto pb-3 pt-1" @scroll="update">
      <TransitionGroup name="session-move">
        <SessionCard v-for="row in cards" :key="row.tab.id"
          :row="row"
          :branch="branches.get(row.directory.id)"
          :root-name="rootOf(row.directory).name"
          :root-dir-id="rootOf(row.directory).id"
          :is-worktree="!!row.directory.parentDirectoryId"
          :now="now" />
      </TransitionGroup>
      <div v-if="cards.length === 0 && rootDirs.length" class="flex h-24 items-center justify-center px-4 text-center text-xs text-muted-foreground">
        No sessions — right-click the chip or press ⌘T
      </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.session-move-move {
  transition: transform 240ms ease;
}
.session-move-enter-active {
  transition: opacity 180ms ease;
}
.session-move-enter-from {
  opacity: 0;
}
</style>
