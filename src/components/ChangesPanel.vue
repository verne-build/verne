<script setup lang="ts">
import {
  computed,
  ref,
  nextTick,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
  watch,
} from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { listen } from "@/platform";
import { useRpc } from "@/composables/useRpc";
import FileIcon from "./FileIcon.vue";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Textarea } from "./ui/textarea";
import { Kbd } from "./ui/kbd";
import { ScrollArea } from "./ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  Plus,
  GitBranch,
  Minus,
  Check,
  Loader2,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import type { GitStatus, GitFileEntry, GitOperationProgress } from "@/types";

const gitStatusCache = new Map<string, GitStatus>();
const gitOperationState = new Map<
  string,
  {
    action: GitOperationProgress["action"];
    completed: number;
    total: number;
  }
>();

const props = defineProps<{
  workingDir: string;
  activeRelPath?: string | null;
  activeStaged?: boolean | null;
  /** relPath -> pending review-comment count, for the per-file badge. */
  commentCounts?: Record<string, number>;
}>();

function commentCount(relPath: string): number {
  return props.commentCounts?.[relPath] ?? 0;
}

const emit = defineEmits<{
  openFile: [path: string];
  openDiff: [filePath: string, staged: boolean];
  discard: [relPath: string];
  statusChanged: [status: GitStatus | null];
}>();

function isActive(path: string, staged: boolean) {
  return props.activeRelPath === path && props.activeStaged === staged;
}

function absPath(relPath: string): string {
  return `${props.workingDir}/${relPath}`;
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${label}`);
  } catch (e) {
    toast.error(`Copy failed: ${e}`);
  }
}

function viewFile(relPath: string) {
  emit("openFile", absPath(relPath));
}

function copyAbs(relPath: string) {
  copyText(absPath(relPath), "path");
}

function copyRel(relPath: string) {
  copyText(relPath, "relative path");
}

function discardFile(relPath: string) {
  emit("discard", relPath);
}

const { request } = useRpc();
const initialCachedStatus = gitStatusCache.get(props.workingDir) ?? null;

const status = ref<GitStatus | null>(initialCachedStatus);
const commitMessage = ref("");
const loading = ref(!initialCachedStatus);
const noRepo = ref(false);
const commitError = ref("");
const stagedOpen = ref(true);
const changesOpen = ref(true);
const committing = ref(false);
const initializing = ref(false);
const scrollAreaRef = ref<HTMLElement | null>(null);
const stagedListRef = ref<HTMLElement | null>(null);
const changesListRef = ref<HTMLElement | null>(null);
const stagedScrollMargin = ref(0);
const changesScrollMargin = ref(0);
const ROW_HEIGHT = 26;
const OVERSCAN = 10;

watch(commitMessage, () => nextTick(updateVirtualLayout));

const stagedEntries = computed(() => status.value?.staged ?? []);
const changeEntries = computed(() =>
  status.value ? [...status.value.unstaged, ...status.value.untracked] : [],
);

function getScrollViewport(): HTMLElement | null {
  const el = (scrollAreaRef.value as any)?.$el ?? scrollAreaRef.value;
  return el?.querySelector("[data-slot=scroll-area-viewport]") ?? null;
}

async function resetScrollPosition() {
  await nextTick();
  const viewport = getScrollViewport();
  if (!viewport) return;
  viewport.scrollTop = 0;
  stagedVirtualizer.value.scrollToOffset(0);
  changesVirtualizer.value.scrollToOffset(0);
  stagedVirtualizer.value.measure();
  changesVirtualizer.value.measure();
}

async function syncVirtualizerViewport() {
  await nextTick();
  stagedVirtualizer.value.measure();
  changesVirtualizer.value.measure();
  const viewport = getScrollViewport();
  if (!viewport) return;
  viewport.dispatchEvent(new Event("scroll"));
}

async function updateVirtualLayout() {
  await nextTick();
  stagedScrollMargin.value = stagedListRef.value?.offsetTop ?? 0;
  changesScrollMargin.value = changesListRef.value?.offsetTop ?? 0;
  stagedVirtualizer.value.measure();
  changesVirtualizer.value.measure();
}

const stagedVirtualizer = useVirtualizer(
  computed(() => ({
    count: stagedOpen.value ? stagedEntries.value.length : 0,
    getScrollElement: getScrollViewport,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollMargin: stagedScrollMargin.value,
    getItemKey: (index: number) => stagedEntries.value[index]?.path ?? index,
  })),
);

const changesVirtualizer = useVirtualizer(
  computed(() => ({
    count: changesOpen.value ? changeEntries.value.length : 0,
    getScrollElement: getScrollViewport,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollMargin: changesScrollMargin.value,
    getItemKey: (index: number) => changeEntries.value[index]?.path ?? index,
  })),
);

const stagedItems = computed(() => stagedVirtualizer.value.getVirtualItems());
const changeItems = computed(() => changesVirtualizer.value.getVirtualItems());

function fileRowParts(entry: GitFileEntry) {
  const slash = entry.path.lastIndexOf("/");
  return {
    name: slash >= 0 ? entry.path.slice(slash + 1) : entry.path,
    parent: slash >= 0 ? entry.path.slice(0, slash) : "",
  };
}

const stagedRows = computed(() =>
  stagedItems.value.flatMap((item) => {
    const entry = stagedEntries.value[item.index];
    return entry ? [{ item, entry, ...fileRowParts(entry) }] : [];
  }),
);
const changeRows = computed(() =>
  changeItems.value.flatMap((item) => {
    const entry = changeEntries.value[item.index];
    return entry ? [{ item, entry, ...fileRowParts(entry) }] : [];
  }),
);

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let unlistenGit: (() => void) | undefined;
let unlistenDir: (() => void) | undefined;
let unlistenGitProgress: (() => void) | undefined;
let pendingResetTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSyncTimer: ReturnType<typeof setTimeout> | undefined;
let commitErrorTimer: ReturnType<typeof setTimeout> | undefined;
let refreshGeneration = 0;
const gitProgressToastId = "git-operation-progress";
const activeGitProgressAction = ref<GitOperationProgress["action"] | null>(null);
const activeGitProgressPath = ref<string | null>(null);

function isCancelledGitOperation(error: unknown) {
  return String(error).includes("git operation cancelled");
}

function activeOperationFor(path: string) {
  return gitOperationState.get(path) ?? null;
}

function shouldSkipImmediateRefresh(path: string) {
  return !!activeOperationFor(path) && !!gitStatusCache.get(path);
}

function restoreGitProgressToast(path: string) {
  const progress = activeOperationFor(path);
  if (!progress || progress.total <= 1) return;
  activeGitProgressAction.value = progress.action;
  activeGitProgressPath.value = path;
  toast.loading(
    `${gitActionLabel(progress.action)} ${progress.completed}/${progress.total} files`,
    gitProgressToastOptions(),
  );
}

async function cancelActiveGitOperation() {
  const path = activeGitProgressPath.value;
  if (!path) return;
  try {
    await request.cancelGitOperation({ path });
    toast.loading("Cancelling...", {
      id: gitProgressToastId,
      duration: Infinity,
    });
  } catch (e) {
    toast.error(`Cancel failed: ${e}`, {
      id: gitProgressToastId,
      duration: 5000,
    });
  }
}

function gitProgressToastOptions() {
  return {
    id: gitProgressToastId,
    duration: Infinity,
    cancel: {
      label: "Cancel",
      onClick: () => {
        void cancelActiveGitOperation();
      },
    },
  } as const;
}

function gitActionLabel(action: GitOperationProgress["action"]) {
  return action === "stage" ? "Staging" : "Unstaging";
}

function beginGitProgress(action: GitOperationProgress["action"], total: number) {
  if (total <= 1) return;
  activeGitProgressAction.value = action;
  activeGitProgressPath.value = props.workingDir;
  gitOperationState.set(props.workingDir, { action, completed: 0, total });
  toast.loading(`${gitActionLabel(action)} 0/${total}`, {
    ...gitProgressToastOptions(),
  });
}

function updateGitProgress(progress: GitOperationProgress) {
  if (progress.total <= 1) return;
  gitOperationState.set(progress.path, {
    action: progress.action,
    completed: progress.completed,
    total: progress.total,
  });
  if (activeGitProgressPath.value !== progress.path) return;
  if (activeGitProgressAction.value !== progress.action) return;
  toast.loading(
    `${gitActionLabel(progress.action)} ${progress.completed}/${progress.total}`,
    gitProgressToastOptions(),
  );
}

function finishGitProgress(
  action: GitOperationProgress["action"],
  total: number,
  error?: unknown,
) {
  if (total <= 1) return;
  gitOperationState.delete(props.workingDir);
  activeGitProgressAction.value = null;
  activeGitProgressPath.value = null;
  if (isCancelledGitOperation(error)) {
    toast.dismiss(gitProgressToastId);
    return;
  }
  if (error) {
    toast.error(
      `${action === "stage" ? "Stage" : "Unstage"} failed: ${String(error)}`,
      {
        id: gitProgressToastId,
        duration: 5000,
      },
    );
    return;
  }
  toast.dismiss(gitProgressToastId);
}

async function refresh() {
  const generation = ++refreshGeneration;
  const workingDir = props.workingDir;
  try {
    const s = await request.gitStatus({ path: workingDir });
    if (generation !== refreshGeneration || workingDir !== props.workingDir) return;
    status.value = s;
    gitStatusCache.set(workingDir, s);
    emit("statusChanged", s);
    noRepo.value = false;
    void updateVirtualLayout();
  } catch (e) {
    if (generation !== refreshGeneration || workingDir !== props.workingDir) return;
    console.error("git status:", e);
    emit("statusChanged", null);
    if (!status.value) noRepo.value = true;
  } finally {
    if (generation === refreshGeneration && workingDir === props.workingDir) {
      loading.value = false;
    }
  }
}

function debouncedRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refresh, 150);
}

function scheduleResetScrollPosition() {
  clearTimeout(pendingResetTimer);
  pendingResetTimer = setTimeout(() => {
    void resetScrollPosition();
  }, 0);
}

function scheduleVirtualizerSync() {
  clearTimeout(pendingResetTimer);
  clearTimeout(pendingSyncTimer);
  pendingSyncTimer = setTimeout(() => {
    void syncVirtualizerViewport();
  }, 0);
}

async function stageFile(path: string) {
  try {
    await request.gitStage({ path: props.workingDir, files: [path] });
    window.dispatchEvent(
      new CustomEvent("close-git-diff", { detail: { relPath: path } }),
    );
  } catch (e) {
    console.error("stage:", e);
    toast.error(`Stage failed: ${e}`);
  }
  refresh();
}

async function unstageFile(path: string) {
  try {
    await request.gitUnstage({ path: props.workingDir, files: [path] });
    window.dispatchEvent(
      new CustomEvent("close-git-diff", { detail: { relPath: path } }),
    );
  } catch (e) {
    console.error("unstage:", e);
    toast.error(`Unstage failed: ${e}`);
  }
  refresh();
}

async function stageAll() {
  const total = changeEntries.value.length;
  beginGitProgress("stage", total);
  try {
    await request.gitStageAll({ path: props.workingDir });
    window.dispatchEvent(
      new CustomEvent("close-git-diff", { detail: { all: true } }),
    );
    finishGitProgress("stage", total);
  } catch (e) {
    if (!isCancelledGitOperation(e)) console.error("stage all:", e);
    finishGitProgress("stage", total, e);
  }
  refresh();
}

async function unstageAll() {
  const total = stagedEntries.value.length;
  beginGitProgress("unstage", total);
  try {
    await request.gitUnstageAll({ path: props.workingDir });
    window.dispatchEvent(
      new CustomEvent("close-git-diff", { detail: { all: true } }),
    );
    finishGitProgress("unstage", total);
  } catch (e) {
    if (!isCancelledGitOperation(e)) console.error("unstage all:", e);
    finishGitProgress("unstage", total, e);
  }
  refresh();
}

async function doCommit() {
  if (!commitMessage.value.trim() || !status.value?.staged.length) return;
  committing.value = true;
  commitError.value = "";
  try {
    await request.gitCommit({
      path: props.workingDir,
      message: commitMessage.value,
    });
    commitMessage.value = "";
    window.dispatchEvent(
      new CustomEvent("close-git-diff", { detail: { all: true } }),
    );
    refresh();
  } catch (e) {
    console.error("commit:", e);
    commitError.value = String(e);
    clearTimeout(commitErrorTimer);
    commitErrorTimer = setTimeout(() => (commitError.value = ""), 5000);
  } finally {
    committing.value = false;
  }
}

async function initRepo() {
  if (initializing.value) return;
  initializing.value = true;
  try {
    await request.gitInit({ path: props.workingDir });
    await refresh();
  } catch (e) {
    console.error("git init:", e);
    toast.error(`Failed to initialize repository: ${e}`);
  } finally {
    initializing.value = false;
  }
}

function openFileDiff(entry: GitFileEntry, staged: boolean) {
  if (entry.isBinary) {
    const fullPath = props.workingDir + "/" + entry.path;
    emit("openFile", fullPath);
    return;
  }
  emit("openDiff", entry.path, staged);
}

function statusStyle(s: string) {
  switch (s) {
    case "A":
      return { color: "var(--git-added)" };
    case "M":
      return { color: "var(--git-modified)" };
    case "D":
      return { color: "var(--git-deleted)" };
    case "R":
      return { color: "var(--git-renamed)" };
    case "U":
      return { color: "var(--git-untracked)" };
    default:
      return { color: "var(--git-untracked)" };
  }
}

onMounted(async () => {
  status.value = gitStatusCache.get(props.workingDir) ?? null;
  emit("statusChanged", status.value);
  loading.value = !status.value;
  noRepo.value = false;
  restoreGitProgressToast(props.workingDir);
  request.setSourceControlVisible({ visible: true }).catch(() => {});
  await request.gitWatch({ path: props.workingDir });
  unlistenGit = await listen<string>("git-status-changed", (ev) => {
    if (ev.payload === props.workingDir) debouncedRefresh();
  });
  unlistenDir = await listen<string>("directory-changed", (ev) => {
    if (ev.payload === props.workingDir) debouncedRefresh();
  });
  unlistenGitProgress = await listen<GitOperationProgress>(
    "git-operation-progress",
    (ev) => {
      if (ev.payload.path !== props.workingDir) return;
      restoreGitProgressToast(ev.payload.path);
      updateGitProgress(ev.payload);
    },
  );
  if (!shouldSkipImmediateRefresh(props.workingDir)) {
    refresh();
  }
});

onActivated(() => {
  restoreGitProgressToast(props.workingDir);
  request.setSourceControlVisible({ visible: true }).catch(() => {});
  scheduleVirtualizerSync();
});

onDeactivated(() => {
  request.setSourceControlVisible({ visible: false }).catch(() => {});
  scheduleResetScrollPosition();
});

onUnmounted(() => {
  request.setSourceControlVisible({ visible: false }).catch(() => {});
  refreshGeneration++;
  unlistenGit?.();
  unlistenDir?.();
  unlistenGitProgress?.();
  request.gitUnwatch({ path: props.workingDir });
  clearTimeout(debounceTimer);
  clearTimeout(pendingResetTimer);
  clearTimeout(pendingSyncTimer);
  clearTimeout(commitErrorTimer);
});

watch(
  () => props.workingDir,
  (newPath, oldPath) => {
    refreshGeneration++;
    if (oldPath) request.gitUnwatch({ path: oldPath });
    const cached = gitStatusCache.get(newPath) ?? null;
    status.value = cached;
    emit("statusChanged", cached);
    loading.value = !cached;
    noRepo.value = false;
    restoreGitProgressToast(newPath);
    request.gitWatch({ path: newPath });
    if (!shouldSkipImmediateRefresh(newPath)) {
      refresh();
    }
  },
);

watch(
  () => [
    stagedEntries.value.length,
    changeEntries.value.length,
    stagedOpen.value,
    changesOpen.value,
    loading.value,
  ],
  () => {
    void updateVirtualLayout();
  },
  { flush: "post" },
);
</script>

<template>
  <div
    class="flex flex-col h-full text-xs @container/sc"
    style="container-type: size"
  >
    <!-- Not a git repo -->
    <div
      v-if="!loading && noRepo"
      class="h-full flex items-center justify-center"
    >
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranch class="size-5" />
          </EmptyMedia>
          <EmptyTitle class="text-base">No Repository</EmptyTitle>
          <EmptyDescription>This folder isn't tracked by Git yet.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" tabindex="0" :disabled="initializing" @click="initRepo">
            <Loader2 v-if="initializing" class="size-4 animate-spin" />
            Initialize Repository
          </Button>
        </EmptyContent>
      </Empty>
    </div>

    <ScrollArea
      v-else-if="status"
      ref="scrollAreaRef"
      class="flex-1 min-h-0"
    >
      <div class="pb-8">
        <!-- Commit area -->
        <div class="px-3 pt-3 pb-2 space-y-2">
          <Textarea
            v-model="commitMessage"
            placeholder="Commit message"
            class="min-h-9 resize-none overflow-y-auto max-h-[30cqh] dark:bg-[var(--editor-bg)] px-3 py-1.5 text-xs leading-5 [field-sizing:content]"
            rows="1"
            required
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown.meta.enter="doCommit"
          />
          <Button
            size="xs"
            variant="outline"
            class="w-full justify-between cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!commitMessage.trim() || !status.staged.length || committing"
            @click="doCommit"
          >
            <span class="flex items-center gap-1.5">
              <Check class="size-4" />
              Commit
            </span>
            <Kbd variant="outline" class="h-4 min-w-0 px-1 text-[10px]">⌘↵</Kbd>
          </Button>
          <p v-if="commitError" class="text-[10px] text-red-500">
            {{ commitError }}
          </p>
        </div>

        <!-- File sections -->
        <!-- Staged -->
        <Collapsible v-model:open="stagedOpen">
          <div
            class="group flex items-center gap-1 px-3 py-1.5 text-muted-foreground font-medium"
          >
            <CollapsibleTrigger class="flex items-center gap-1 flex-1">
              <span
                class="size-0 border-l-[5px] border-l-current border-y-[3.5px] border-y-transparent transition-transform"
                :class="{ 'rotate-90': stagedOpen }"
              />
              Staged Changes
            </CollapsibleTrigger>
            <Button
              v-if="status.staged.length"
              size="icon-xs"
              variant="ghost"
              class="opacity-0 group-hover:opacity-100"
              tabindex="0"
              title="Unstage All"
              @click="unstageAll"
            >
              <Minus class="size-4" />
            </Button>
            <Badge
              v-if="status.staged.length"
              class="bg-muted-foreground/50 w-auto min-w-2.5 height-4.5 py-0 px-1.5 text-[12px] text-foreground"
            >
              {{ status.staged.length }}
            </Badge>
          </div>
          <CollapsibleContent>
            <div ref="stagedListRef" class="relative">
              <div
                class="relative"
                :style="{ height: `${stagedVirtualizer.getTotalSize()}px` }"
              >
                <div
                  v-for="row in stagedRows"
                  :key="`staged:${row.item.key}`"
                  class="absolute left-0 top-0 w-full"
                  :style="{
                    transform: `translateY(${row.item.start - stagedScrollMargin}px)`,
                  }"
                >
                  <ContextMenu>
                    <ContextMenuTrigger as-child>
                      <div
                        class="group flex items-center gap-1.5 pl-[17px] pr-2 h-6 mt-0.5 mx-1 rounded-md cursor-pointer"
                        :class="isActive(row.entry.path, true) ? 'bg-border/50' : 'hover:bg-border/25'"
                        @click="openFileDiff(row.entry, true)"
                      >
                        <FileIcon
                          :name="row.name"
                          :size="14"
                        />
                        <span
                          class="flex-1 min-w-0 truncate text-[10px] text-muted-foreground"
                          :title="row.entry.path"
                        >
                          <span class="text-xs text-foreground">{{ row.name }}</span>
                          <span v-if="row.parent" class="ml-2">{{ row.parent }}</span>
                        </span>
                        <span
                          v-if="commentCount(row.entry.path) > 0"
                          class="shrink-0 rounded bg-primary/20 px-1 text-[9px] font-medium text-primary"
                          :title="`${commentCount(row.entry.path)} review comment(s)`"
                        >{{ commentCount(row.entry.path) }}</span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          class="hidden group-hover:inline-flex shrink-0"
                          tabindex="0"
                          title="Unstage"
                          @click.stop="unstageFile(row.entry.path)"
                        >
                          <Minus class="size-4" />
                        </Button>
                        <span
                          :style="statusStyle(row.entry.status)"
                          class="text-[12px] font-bold w-3 text-right"
                        >
                          {{ row.entry.status }}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent @close-auto-focus.prevent>
                      <ContextMenuItem @select="viewFile(row.entry.path)">View</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem @select="copyAbs(row.entry.path)">Copy Path</ContextMenuItem>
                      <ContextMenuItem @select="copyRel(row.entry.path)">Copy Relative Path</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem @select="unstageFile(row.entry.path)">Unstage</ContextMenuItem>
                      <ContextMenuItem @select="discardFile(row.entry.path)">Discard Changes</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <!-- Unstaged + Untracked -->
        <Collapsible v-model:open="changesOpen">
          <div
            class="group flex items-center gap-1 px-3 py-1.5 text-muted-foreground font-medium"
          >
            <CollapsibleTrigger class="flex items-center gap-1 flex-1">
              <span
                class="size-0 border-l-[5px] border-l-current border-y-[3.5px] border-y-transparent transition-transform"
                :class="{ 'rotate-90': changesOpen }"
              />
              Changes
            </CollapsibleTrigger>
            <Button
              v-if="status.unstaged.length + status.untracked.length"
              size="icon-xs"
              variant="ghost"
              class="opacity-0 group-hover:opacity-100"
              tabindex="0"
              title="Stage All"
              @click="stageAll"
            >
              <Plus class="size-4" />
            </Button>
            <Badge
              v-if="status.unstaged.length + status.untracked.length"
              class="bg-muted-foreground/50 w-auto min-w-2.5 height-4.5 py-0 px-1.5 text-[12px] text-foreground"
            >
              {{ status.unstaged.length + status.untracked.length }}
            </Badge>
          </div>
          <CollapsibleContent>
            <div ref="changesListRef" class="relative">
              <div
                class="relative"
                :style="{ height: `${changesVirtualizer.getTotalSize()}px` }"
              >
                <div
                  v-for="row in changeRows"
                  :key="`change:${row.item.key}`"
                  class="absolute left-0 top-0 w-full"
                  :style="{
                    transform: `translateY(${row.item.start - changesScrollMargin}px)`,
                  }"
                >
                  <ContextMenu>
                    <ContextMenuTrigger as-child>
                      <div
                        class="group flex items-center gap-1.5 pl-[17px] pr-2 h-6 mt-0.5 mx-1 rounded-md cursor-pointer"
                        :class="isActive(row.entry.path, false) ? 'bg-border/50' : 'hover:bg-border/25'"
                        @click="openFileDiff(row.entry, false)"
                      >
                        <FileIcon
                          :name="row.name"
                          :size="14"
                        />
                        <span
                          class="flex-1 min-w-0 truncate text-[10px] text-muted-foreground"
                          :title="row.entry.path"
                        >
                          <span class="text-xs text-foreground">{{ row.name }}</span>
                          <span v-if="row.parent" class="ml-2">{{ row.parent }}</span>
                        </span>
                        <span
                          v-if="commentCount(row.entry.path) > 0"
                          class="shrink-0 rounded bg-primary/20 px-1 text-[9px] font-medium text-primary"
                          :title="`${commentCount(row.entry.path)} review comment(s)`"
                        >{{ commentCount(row.entry.path) }}</span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          class="hidden group-hover:inline-flex shrink-0"
                          tabindex="0"
                          title="Stage"
                          @click.stop="stageFile(row.entry.path)"
                        >
                          <Plus class="size-4" />
                        </Button>
                        <span
                          :style="statusStyle(row.entry.status)"
                          class="text-[12px] font-bold w-3 text-right"
                        >
                          {{ row.entry.status }}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent @close-auto-focus.prevent>
                      <ContextMenuItem @select="viewFile(row.entry.path)">View</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem @select="copyAbs(row.entry.path)">Copy Path</ContextMenuItem>
                      <ContextMenuItem @select="copyRel(row.entry.path)">Copy Relative Path</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem @select="stageFile(row.entry.path)">Stage</ContextMenuItem>
                      <ContextMenuItem @select="discardFile(row.entry.path)">Discard Changes</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <!-- No changes -->
        <div
          v-if="
            !status.staged.length &&
            !status.unstaged.length &&
            !status.untracked.length
          "
          class="p-3 text-muted-foreground"
        >
          No changes
        </div>
      </div>
    </ScrollArea>

    <div v-else class="h-full flex items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Loader2 class="size-5 animate-spin" />
          </EmptyMedia>
          <EmptyTitle class="text-base">Loading Changes</EmptyTitle>
          <EmptyDescription>Scanning repository status…</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  </div>
</template>
