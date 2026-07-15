<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, onActivated, onDeactivated, nextTick } from "vue";
import { useRpc } from "@/composables/useRpc";
import { listen, ask, type UnlistenFn } from "@/platform";
import type { GitCommitInfo, GitCommitFileEntry } from "@/types";
import { RefreshCw, GitBranch, Cloud } from "@lucide/vue";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { toast } from "vue-sonner";
import FileIcon from "./FileIcon.vue";

const props = defineProps<{
  workingDir: string;
  activeRelPath?: string | null;
  activeCommitId?: string | null;
}>();
const emit = defineEmits<{
  openDiff: [filePath: string, commitId: string, shortId: string];
}>();

function isActiveFile(commitId: string, path: string) {
  return props.activeCommitId === commitId && props.activeRelPath === path;
}

const ROW_HEIGHT = 50;
const FILE_ROW_HEIGHT = 26;
const PAGE_SIZE = 50;

const commits = ref<GitCommitInfo[]>([]);
const hasMore = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const stale = ref(false);
const isActive = ref(true);

const expandedSet = ref(new Set<string>());
const fileCache = ref(new Map<string, GitCommitFileEntry[]>());
const loadingFiles = ref(new Set<string>());

const scrollContainer = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const containerHeight = ref(400);

let unlisten: UnlistenFn | null = null;
let commitFetchGeneration = 0;

const rowHeights = computed(() => {
  return commits.value.map(c => {
    if (!expandedSet.value.has(c.id)) return ROW_HEIGHT;
    const files = fileCache.value.get(c.id);
    const fileCount = files?.length ?? 0;
    return ROW_HEIGHT + (fileCount * FILE_ROW_HEIGHT);
  });
});

const totalHeight = computed(() => rowHeights.value.reduce((sum, h) => sum + h, 0));

const visibleRange = computed(() => {
  const overscan = 10;
  let startY = 0;
  let startIdx = 0;
  for (let i = 0; i < rowHeights.value.length; i++) {
    if (startY + rowHeights.value[i] > scrollTop.value) {
      startIdx = i;
      break;
    }
    startY += rowHeights.value[i];
  }
  startIdx = Math.max(0, startIdx - overscan);

  let endIdx = startIdx;
  let accum = 0;
  for (let i = startIdx; i < rowHeights.value.length; i++) {
    accum += rowHeights.value[i];
    endIdx = i;
    if (accum > containerHeight.value + overscan * ROW_HEIGHT) break;
  }
  endIdx = Math.min(rowHeights.value.length - 1, endIdx + overscan);

  return { start: startIdx, end: endIdx };
});

const visibleRows = computed(() => {
  const { start, end } = visibleRange.value;
  let offsetY = 0;
  for (let i = 0; i < start; i++) offsetY += rowHeights.value[i];

  const rows = [];
  for (let i = start; i <= end && i < commits.value.length; i++) {
    rows.push({ commit: commits.value[i], top: offsetY, height: rowHeights.value[i] });
    offsetY += rowHeights.value[i];
  }
  return rows;
});

// Outgoing commits: from HEAD down until hitting the first origin/* ref
const outgoingCommits = computed(() => {
  const set = new Set<string>();
  const headIdx = commits.value.findIndex(c => c.refs.includes("HEAD"));
  if (headIdx < 0) return set;
  let foundOrigin = false;
  for (let i = headIdx; i < commits.value.length; i++) {
    const c = commits.value[i];
    if (c.refs.some(r => r.startsWith("origin/"))) {
      foundOrigin = true;
      break;
    }
    set.add(c.id);
  }
  if (!foundOrigin) return new Set<string>();
  return set;
});

function avatarUrl(email: string): string {
  const e = email.trim().toLowerCase();
  // GitHub noreply emails: extract username directly
  const noreplyMatch = e.match(/^(\d+\+)?(.+)@users\.noreply\.github\.com$/);
  if (noreplyMatch) {
    return `https://github.com/${noreplyMatch[2]}.png?size=32`;
  }
  // For all emails, try GitHub's email→avatar resolution
  return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(e)}&s=32`;
}

function relativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const d = now - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  if (d < 2592000) return `${Math.floor(d / 604800)}w ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function filteredRefs(refs: string[]): string[] {
  return refs.filter(r => r !== "HEAD");
}

function fileStatusColor(status: string) {
  switch (status) {
    case "A": return { color: "var(--git-added)" };
    case "M": return { color: "var(--git-modified)" };
    case "D": return { color: "var(--git-deleted)" };
    case "R": return { color: "var(--git-renamed)" };
    case "U": return { color: "var(--git-untracked)" };
    default: return { color: "var(--git-untracked)" };
  }
}

async function fetchCommits(skip = 0) {
  if (loading.value) return;
  const generation = ++commitFetchGeneration;
  const workingDir = props.workingDir;
  loading.value = true;
  error.value = null;
  try {
    const result = await useRpc().request.gitCommitLog({
      path: workingDir,
      count: PAGE_SIZE,
      skip,
    });
    if (generation !== commitFetchGeneration || workingDir !== props.workingDir) return;
    if (skip === 0) {
      commits.value = result.commits;
    } else {
      commits.value = [...commits.value, ...result.commits];
    }
    hasMore.value = result.hasMore;
    stale.value = false;
  } catch (e: any) {
    if (generation !== commitFetchGeneration || workingDir !== props.workingDir) return;
    if (skip === 0) {
      error.value = e?.message ?? String(e);
    }
  } finally {
    if (generation === commitFetchGeneration && workingDir === props.workingDir) {
      loading.value = false;
    }
  }
}

async function loadMore() {
  if (!hasMore.value || loading.value) return;
  await fetchCommits(commits.value.length);
}

async function toggleExpand(commitId: string) {
  const set = new Set(expandedSet.value);
  if (set.has(commitId)) {
    set.delete(commitId);
    expandedSet.value = set;
    return;
  }
  set.add(commitId);
  expandedSet.value = set;

  if (!fileCache.value.has(commitId)) {
    loadingFiles.value = new Set([...loadingFiles.value, commitId]);
    try {
      const result = await useRpc().request.gitCommitFiles({
        path: props.workingDir,
        commitId,
      });
      fileCache.value.set(commitId, result.files);
    } catch (e) {
      toast.error(`Couldn't load commit files: ${e}`);
    }
    loadingFiles.value = new Set([...loadingFiles.value].filter(id => id !== commitId));
  }
}

function openFileDiff(commitId: string, shortId: string, filePath: string) {
  emit("openDiff", filePath, commitId, shortId);
}

function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  scrollTop.value = el.scrollTop;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
    loadMore();
  }
}

function copySha(commit: GitCommitInfo) {
  navigator.clipboard.writeText(commit.id).catch(() => {});
  toast.success("Copied SHA");
}

function copyMessage(commit: GitCommitInfo) {
  navigator.clipboard.writeText(commit.message).catch(() => {});
  toast.success("Copied commit message");
}

async function cherryPick(commit: GitCommitInfo) {
  const ok = await ask("Cherry-pick this commit onto the current branch?", {
    detail: "Applies the commit's changes; may cause conflicts.",
    confirmLabel: "Cherry-Pick",
    kind: "warning",
  });
  if (!ok) return;
  try {
    await useRpc().request.gitCherryPick({ path: props.workingDir, commitId: commit.id });
    toast.success("Cherry-picked");
    fetchCommits(0);
  } catch (e) {
    toast.error(`Cherry-pick failed: ${e}`);
  }
}

async function revert(commit: GitCommitInfo) {
  const ok = await ask("Revert this commit?", {
    detail: "Creates a new commit undoing its changes.",
    confirmLabel: "Revert",
    kind: "warning",
  });
  if (!ok) return;
  try {
    await useRpc().request.gitRevert({ path: props.workingDir, commitId: commit.id });
    toast.success("Reverted");
    fetchCommits(0);
  } catch (e) {
    toast.error(`Revert failed: ${e}`);
  }
}

let resizeObs: ResizeObserver | null = null;

onMounted(async () => {
  fetchCommits(0);
  unlisten = await listen("git-status-changed", () => {
    if (isActive.value) {
      fetchCommits(0);
    } else {
      stale.value = true;
    }
  });

  await nextTick();
  const el = scrollContainer.value;
  if (el) {
    containerHeight.value = el.clientHeight;
    resizeObs = new ResizeObserver(entries => {
      containerHeight.value = entries[0]?.contentRect.height ?? 400;
    });
    resizeObs.observe(el);
  }
});

onUnmounted(() => {
  if (unlisten) unlisten();
  if (resizeObs) resizeObs.disconnect();
});

onActivated(() => {
  isActive.value = true;
  if (stale.value) fetchCommits(0);
});

onDeactivated(() => {
  isActive.value = false;
});

watch(() => props.workingDir, () => {
  commitFetchGeneration++;
  commits.value = [];
  expandedSet.value = new Set();
  fileCache.value = new Map();
  loading.value = false;
  fetchCommits(0);
});
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="error && commits.length === 0" class="flex flex-col items-center justify-center h-full text-xs text-muted-foreground gap-2 px-4">
      <p class="text-center">{{ error }}</p>
      <Button size="xs" variant="ghost" @click="fetchCommits(0)">
        <RefreshCw class="size-3 mr-1" /> Retry
      </Button>
    </div>

    <div v-else-if="!loading && commits.length === 0" class="flex items-center justify-center h-full text-xs text-muted-foreground">
      No commits yet
    </div>

    <div
      v-else
      ref="scrollContainer"
      class="app-scrollbar flex-1 overflow-y-auto min-h-0"
      @scroll="onScroll"
    >
      <div :style="{ height: totalHeight + 'px', position: 'relative' }">
        <div
          v-for="{ commit, top, height } in visibleRows"
          :key="commit.id"
          :style="{ position: 'absolute', top: top + 'px', left: 0, right: 0, height: height + 'px' }"
        >
          <!-- Commit row -->
          <ContextMenu>
            <ContextMenuTrigger as-child>
              <div
                class="flex items-start h-12 mx-1 px-1.5 py-1.5 gap-1.5 rounded-md cursor-pointer text-xs group hover:bg-muted/50"
                @click="toggleExpand(commit.id)"
              >
                <span
                  class="size-0 border-l-[5px] border-l-current border-y-[3.5px] border-y-transparent transition-transform shrink-0 mt-1 text-muted-foreground"
                  :class="{ 'rotate-90': expandedSet.has(commit.id) }"
                />
                <div class="flex flex-col min-w-0 flex-1 gap-1">
                  <span class="truncate text-foreground">{{ commit.message }}</span>
                  <div class="flex items-center gap-2 min-w-0">
                    <img
                      :src="avatarUrl(commit.authorEmail)"
                      class="size-4 rounded-full shrink-0"
                      loading="lazy"
                      @error="($event.target as HTMLImageElement).style.display = 'none'"
                    />
                    <span class="text-muted-foreground/60 shrink-0">{{ relativeTime(commit.timestamp) }}</span>
                    <span
                      v-for="r in filteredRefs(commit.refs)"
                      :key="r"
                      class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium inline-flex items-center gap-0.5 bg-muted text-muted-foreground"
                    ><Cloud v-if="r.startsWith('origin/')" class="size-2.5" /><GitBranch v-else class="size-2.5" />{{ r }}</span>
                  </div>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem @select="copySha(commit)">Copy SHA</ContextMenuItem>
              <ContextMenuItem @select="copyMessage(commit)">Copy Commit Message</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem @select="cherryPick(commit)">Cherry-Pick Commit</ContextMenuItem>
              <ContextMenuItem @select="revert(commit)">Revert Commit</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          <!-- Expanded files -->
          <div v-if="expandedSet.has(commit.id)">
            <div
              v-if="loadingFiles.has(commit.id)"
              class="flex items-center h-6 mt-0.5 mx-1 pl-[17px] text-xs text-muted-foreground"
            >
              Loading...
            </div>
            <div
              v-for="file in fileCache.get(commit.id) ?? []"
              :key="file.path"
              class="flex items-center gap-1.5 h-6 mt-0.5 mx-1 pl-[17px] pr-2 text-xs cursor-pointer rounded-md"
              :class="isActiveFile(commit.id, file.path) ? 'bg-border/50' : 'hover:bg-muted/50'"
              @click.stop="openFileDiff(commit.id, commit.shortId, file.path)"
            >
              <FileIcon :name="file.path.split('/').pop() || file.path" :size="14" />
              <span class="flex-1 min-w-0 truncate text-[10px] text-muted-foreground" :title="file.path">
                <span class="text-xs text-foreground">{{ file.path.split("/").pop() }}</span>
                <span v-if="file.path.includes('/')" class="ml-2">{{ file.path.substring(0, file.path.lastIndexOf("/")) }}</span>
              </span>
              <span :style="fileStatusColor(file.status)" class="shrink-0 font-bold text-[12px] w-3 text-right">{{ file.status }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="loading" class="py-2 text-center text-xs text-muted-foreground">Loading...</div>
    </div>
  </div>
</template>
