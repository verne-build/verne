<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import { Folder, FolderOpen, GitBranch, Pencil, Plus, Trash2 } from "@lucide/vue";
import { DragDropProvider } from "@dnd-kit/vue";
import { ask } from "@/platform";
import SortableItem from "@/components/dnd/SortableItem.vue";
import { sortableSensors } from "@/components/dnd/sensors";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useProjectIcons } from "@/composables/useProjectIcons";
import { listen, type UnlistenFn } from "@/platform";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useScrollFades } from "@/composables/useScrollFades";
import type { WorkingDirectory } from "@/types";

const store = useWorkspaceStore();
const { request } = useRpc();
const { icons: projectIcons } = useProjectIcons();

// top/bottom content fades against the fixed header
const { bodyEl, atStart, atEnd, update } = useScrollFades();

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
const workspaceGroups = computed(() =>
  rootDirs.value.map((directory) => ({
    directory,
    children: worktreesByParent.value.get(directory.id) ?? [],
  })),
);

const branches = ref(new Map<string, string>());
const pathToId = computed(() => {
  const m = new Map<string, string>();
  for (const d of store.directories) m.set(d.path, d.id);
  return m;
});

async function fetchBranch(d: WorkingDirectory) {
  try {
    const b = await request.gitBranchName({ path: d.path });
    if (b) branches.value.set(d.id, b);
    else branches.value.delete(d.id);
  } catch {
    branches.value.delete(d.id);
  }
  branches.value = new Map(branches.value);
}

// Only root workspaces show a branch caption; worktree rows label by folder
// name. So watch + fetch branch for roots only — no RPCs/watchers for worktree
// ids whose branch is never displayed.
// Track which we've already watched + branch-fetched so a change to the
// directory list only processes the delta, not all N every time.
const watched = new Set<string>();
async function refreshAll() {
  await Promise.all(rootDirs.value.map(async (d) => {
    if (watched.has(d.id)) return;
    watched.add(d.id);
    try { await request.gitWatch({ path: d.path }); } catch {}
    await fetchBranch(d);
  }));
  // Prune entries for removed roots so a later re-add re-watches.
  const live = new Set(rootDirs.value.map((d) => d.id));
  for (const id of [...watched]) if (!live.has(id)) watched.delete(id);
}

let unlistenGit: UnlistenFn | null = null;
onMounted(async () => {
  await refreshAll();
  unlistenGit = await listen<string>("git-status-changed", (ev) => {
    const id = pathToId.value.get(ev.payload);
    if (!id) return;
    const d = store.directories.find((x) => x.id === id);
    if (d) fetchBranch(d);
  });
});
onUnmounted(() => { unlistenGit?.(); });

watch(() => store.directories.map((d) => d.id).join(","), () => { refreshAll(); nextTick(update); });

function select(d: WorkingDirectory) {
  store.selectDirectory(d);
  void store.loadTabsForDirectory(d.id);
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

function onRenameInputMounted(el: HTMLInputElement | null) {
  if (!el) return;
  renameInputEl.value = el;
  requestAnimationFrame(() => {
    if (renameInputEl.value !== el) return;
    el.focus();
    el.select();
  });
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

interface DragEndPayload {
  operation: { source: { id?: string; initialIndex?: number; index?: number; group?: string } | null; canceled?: boolean };
  canceled: boolean;
}
function onDragEnd(e: DragEndPayload) {
  if (e.canceled) return;
  const src = e.operation.source;
  if (!src) return;
  const group = src.group;
  const from = src.initialIndex ?? -1;
  const to = src.index ?? -1;
  if (!group || from < 0 || to < 0 || from === to) return;
  if (group === "workspaces-root") {
    const ids = rootDirs.value.map(d => d.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    store.reorderRootDirectories(ids);
  } else if (group.startsWith("worktrees-")) {
    const parentId = group.slice("worktrees-".length);
    const ids = worktreesByParent.value.get(parentId)?.map(c => c.id) ?? [];
    if (from >= ids.length || to >= ids.length) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    store.reorderWorktrees(parentId, ids);
  }
}
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col">
    <div class="flex h-7 shrink-0 items-center justify-between pl-3 pr-1.5">
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground/70">Workspaces</div>
      <TooltipProvider :delay-duration="200">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground"
              :disabled="store.picking"
              aria-label="Add Workspace"
              @click="store.openAndSelectWorkspace()"
            >
              <Plus class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Add Workspace</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
    <div
      class="pointer-events-none absolute inset-x-0 top-7 z-10 h-4 bg-linear-to-b from-sidebar to-transparent transition-opacity"
      :class="atStart ? 'opacity-0' : 'opacity-100'"
    />
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4 bg-linear-to-t from-sidebar to-transparent transition-opacity"
      :class="atEnd ? 'opacity-0' : 'opacity-100'"
    />
    <div ref="bodyEl" class="app-scrollbar min-h-0 flex-1 overflow-y-auto pb-3" @scroll="update">
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
    <DragDropProvider :sensors="sortableSensors" @drag-end="onDragEnd">
    <div class="flex flex-col gap-0.5">
    <SortableItem
      v-for="(group, i) in workspaceGroups"
      :id="group.directory.id"
      :index="i"
      group="workspaces-root"
      :key="group.directory.id"
      class="flex flex-col gap-0.5 data-[dragging=true]:opacity-50"
    >
      <ContextMenu>
        <ContextMenuTrigger as-child>
          <Button
            :as="'div'"
            :variant="store.selectedDirectoryId === group.directory.id ? 'secondary' : 'ghost'"
            size="sm"
            class="group cursor-pointer mx-1.5 h-auto min-h-10 w-[calc(100%-0.75rem)] flex-col items-start justify-center gap-0.5 whitespace-normal px-2.5 py-1.5 text-xs font-normal"
            @click="select(group.directory)"
          >
            <div class="flex h-4 w-full min-w-0 items-center gap-1.5 leading-none">
              <img v-if="projectIcons[group.directory.id]" :src="projectIcons[group.directory.id]" class="size-3.5 shrink-0" />
              <Folder v-else class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 truncate text-left text-foreground">{{ group.directory.name }}</span>
            </div>
            <div
              v-if="branches.get(group.directory.id)"
              class="flex h-4 w-full min-w-0 items-center pl-[1.25rem] text-xs leading-none text-muted-foreground"
            >
              <span class="min-w-0 truncate text-left">{{ branches.get(group.directory.id) }}</span>
            </div>
          </Button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem @select="onCreateWorktree(group.directory.id)">
            <Plus />
            New Worktree
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @select="onRemoveDirectory(group.directory.id)">
            <Trash2 />
            Remove Workspace
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <SortableItem
        v-for="(c, ci) in group.children"
        :id="c.id"
        :index="ci"
        :group="`worktrees-${group.directory.id}`"
        :key="c.id"
      >
      <ContextMenu>
        <ContextMenuTrigger as-child>
          <Button
            :as="'div'"
            :variant="store.selectedDirectoryId === c.id ? 'secondary' : 'ghost'"
            size="sm"
            class="group cursor-pointer ml-[1.625rem] mr-1.5 h-7 w-[calc(100%-2rem)] items-center justify-start gap-1.5 px-2.5 py-1 text-xs font-normal data-[dragging=true]:opacity-50"
            @click="select(c)"
            @dblclick="startRenameWorktree(c.id)"
          >
            <GitBranch class="size-3.5 shrink-0 text-muted-foreground" />
            <input
              v-if="renamingId === c.id"
              type="text"
              class="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border-b border-primary"
              :value="c.name"
              @click.stop
              @keydown.enter="finishRenameWorktree(c.id, ($event.target as HTMLInputElement).value)"
              @keydown.escape="cancelRenameWorktree()"
              @blur="finishRenameWorktree(c.id, ($event.target as HTMLInputElement).value)"
              @vue:mounted="({ el }: any) => onRenameInputMounted(el)"
            />
            <span v-else class="min-w-0 truncate text-left text-foreground">{{ c.name }}</span>
          </Button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem @select="startRenameWorktree(c.id)">
            <Pencil />
            Rename Worktree
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @select="onRemoveWorktree(c.id)">
            <Trash2 />
            Delete Worktree
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      </SortableItem>
    </SortableItem>
    </div>
    </DragDropProvider>
    </div>
  </div>
</template>
