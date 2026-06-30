<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import type { ScSelection } from "@/composables/useFilePanelTabs";
import type { GitStatus } from "@/types";
import type { ReviewContext } from "@/types/shared";
import { usePanelResizeState } from "@/composables/usePanelResizeState";
import { readCachedPanelState, writeCachedScListVisible } from "@/lib/bootstrapCache";
import { PANEL_SIZES } from "@/lib/panelSizes";
import { useRpc } from "@/composables/useRpc";
import DiffPanelHeader from "./DiffPanelHeader.vue";
import ChangesPanel from "./ChangesPanel.vue";
import DiffView from "./DiffView.vue";
import ReviewBar from "./ReviewBar.vue";
import HeaderBranchPill from "./HeaderBranchPill.vue";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./ui/resizable";
import { Button } from "./ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "./ui/empty";
import { ArrowDown, ArrowUp, UploadCloud, GitCompare } from "@lucide/vue";

const props = defineProps<{
  rootDir: string;
  scopeKey: string | null;
  activeCwd: string;
  selection: ScSelection | null;
  commentCounts: Record<string, number>;
  reviewTotal: number;
  reviewContext: ReviewContext | undefined;
  gitStatus: GitStatus | null;
  gitBusy: "pull" | "push" | "publish" | null;
  canPublish: boolean;
  canSyncUpstream: boolean;
}>();

const emit = defineEmits<{
  "open-file": [abs: string];
  "open-diff": [relPath: string, staged: boolean];
  discard: [relPath: string];
  "status-changed": [s: GitStatus | null];
  jump: [c: import("@/types/shared").ReviewComment];
  revert: [];
  pull: [];
  push: [];
  publish: [];
  "switch-view": [v: "changes" | "history"];
}>();

const scLayout = ref<"unified" | "split">("unified");
const scStats = ref<{ added: number; deleted: number } | null>(null);
watch(() => props.selection, () => { scStats.value = null; });

const LIST_PANEL_MIN_PX = PANEL_SIZES.list.min;
const LIST_PANEL_MAX_PX = PANEL_SIZES.list.max;
const clampListPanelPx = (value: number) =>
  Math.min(LIST_PANEL_MAX_PX, Math.max(LIST_PANEL_MIN_PX, value));

const cached = readCachedPanelState();
const scList = usePanelResizeState({
  cacheKey: "scList",
  pxStateKey: "panel_sc_list_px",
  initialPx: clampListPanelPx(cached.scListPx ?? PANEL_SIZES.list.defaults.changes),
  clamp: clampListPanelPx,
  visibleStateKey: "sc_list_visible",
  initialVisible: cached.scListVisible,
  writeCachedVisible: writeCachedScListVisible,
});

const splitDragging = ref(false);
function preventDragCollapse(panelRef: { resize?: (size: number) => void } | null) {
  if (!splitDragging.value) return;
  nextTick(() => panelRef?.resize?.(LIST_PANEL_MIN_PX));
}

const scDiffFilePath = computed(() =>
  props.selection && props.rootDir ? `${props.rootDir}/${props.selection.relPath}` : null,
);

onMounted(async () => {
  const rpc = useRpc();
  try {
    const [scPx, scVis] = await Promise.all([
      rpc.request.getAppState({ key: "panel_sc_list_px" }),
      rpc.request.getAppState({ key: "sc_list_visible" }),
    ]);
    scList.applyPersisted(scPx, scVis);
  } catch {}
});

onUnmounted(() => {
  scList.dispose();
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden flex-1 min-h-0 @container/sc">
    <DiffPanelHeader
      :list-visible="scList.visible.value"
      :rel-path="selection?.relPath ?? null"
      :stats="scStats"
      :layout="scLayout"
      :can-revert="true"
      view="changes"
      @update:list-visible="scList.visible.value = $event"
      @update:layout="scLayout = $event"
      @revert="emit('revert')"
      @update:view="(v) => emit('switch-view', v)"
    />
    <div class="flex-1 min-h-0">
      <ResizablePanelGroup direction="horizontal" class="h-full" @layout="scList.onLayout">
        <ResizablePanel
          :ref="(el) => (scList.panelRef.value = el)"
          collapsible
          :collapsed-size="0"
          :default-size="scList.sizePx.value"
          :min-size="LIST_PANEL_MIN_PX"
          :max-size="LIST_PANEL_MAX_PX"
          size-unit="px"
          class="bg-sidebar"
          @collapse="preventDragCollapse(scList.panelRef.value)"
        >
          <div class="flex h-full flex-col">
            <ReviewBar
              v-if="scopeKey && reviewTotal > 0"
              :scope-key="scopeKey"
              :cwd="activeCwd"
              @jump="emit('jump', $event)"
            />
            <ChangesPanel
              :working-dir="rootDir"
              :active-rel-path="selection?.relPath ?? null"
              :active-staged="selection?.staged ?? null"
              :comment-counts="commentCounts"
              class="min-h-0 flex-1"
              @open-file="emit('open-file', $event)"
              @open-diff="(r, s) => emit('open-diff', r, s)"
              @discard="emit('discard', $event)"
              @status-changed="emit('status-changed', $event)"
            />
          </div>
        </ResizablePanel>
        <ResizableHandle class="cursor-ew-resize" @dragging="splitDragging = $event" />
        <ResizablePanel :min-size="20">
          <div v-if="selection && scDiffFilePath" class="flex flex-col h-full">
            <DiffView
              :key="`sc:${selection.relPath}:${selection.staged}`"
              :file-path="scDiffFilePath"
              :original="selection.original"
              :modified="selection.modified"
              :root-dir="rootDir"
              :layout="scLayout"
              :review-context="reviewContext"
              class="flex-1 min-h-0"
              @stats="(s) => (scStats = s)"
            />
          </div>
          <div v-else class="flex h-full items-center justify-center bg-sidebar">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><GitCompare /></EmptyMedia>
                <EmptyTitle>No Diff Selected</EmptyTitle>
                <EmptyDescription>Pick a file on the left to view its diff.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    <!-- <footer
      class="flex h-[33px] shrink-0 items-center justify-between gap-2 border-t border-border bg-sidebar px-2 text-xs text-muted-foreground"
    >
      <div class="flex min-w-0 items-center gap-1.5">
        <HeaderBranchPill :show-separator="false" compact />
        <span
          v-if="gitStatus?.upstream"
          class="hidden min-w-0 truncate text-[10px] text-muted-foreground/70 @2xl/sc:inline"
          :title="`Tracking ${gitStatus.upstream}`"
        >
          {{ gitStatus.upstream }}
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <Button
          v-if="canSyncUpstream"
          size="xs"
          variant="ghost"
          class="h-6 gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground has-[>svg]:px-1.5"
          :disabled="!!gitBusy"
          title="Pull"
          @click="emit('pull')"
        >
          <ArrowDown class="size-3" />
          <span class="hidden @2xl/sc:inline">Pull</span>
        </Button>
        <Button
          v-if="canPublish"
          size="xs"
          variant="ghost"
          class="h-6 gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground has-[>svg]:px-1.5"
          :disabled="!!gitBusy"
          :title="`Publish to ${gitStatus?.defaultRemote ?? 'remote'}`"
          @click="emit('publish')"
        >
          <UploadCloud class="size-3" />
          <span>Publish</span>
        </Button>
        <Button
          v-else-if="canSyncUpstream"
          size="xs"
          variant="ghost"
          class="h-6 gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground has-[>svg]:px-1.5"
          :disabled="!!gitBusy"
          title="Push"
          @click="emit('push')"
        >
          <ArrowUp class="size-3" />
          <span class="hidden @2xl/sc:inline">Push</span>
        </Button>
      </div>
    </footer> -->
  </div>
</template>
