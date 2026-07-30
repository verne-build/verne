<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, inject, type Ref } from "vue";
import type { CommitsSelection } from "@/composables/useFilePanelTabs";
import type { ReviewContext } from "@/types/shared";
import { usePanelResizeState } from "@/composables/usePanelResizeState";
import { readCachedPanelState, writeCachedCommitsListVisible } from "@/lib/bootstrapCache";
import { PANEL_SIZES } from "@/lib/panelSizes";
import { useRpc } from "@/composables/useRpc";
import DiffPanelHeader from "./DiffPanelHeader.vue";
import HistoryPanel from "./HistoryPanel.vue";
import DiffView from "./DiffView.vue";
import ReviewBar from "./ReviewBar.vue";
import OverlaySidebarGroup from "./OverlaySidebarGroup.vue";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "./ui/empty";
import { GitCompare } from "@lucide/vue";

const props = defineProps<{
  rootDir: string;
  scopeKey: string | null;
  activeDirId: string;
  activeCwd: string;
  selection: CommitsSelection | null;
  reviewTotal: number;
  reviewContext: ReviewContext | undefined;
}>();

const emit = defineEmits<{
  "open-diff": [filePath: string, commitId: string, shortId: string];
  jump: [c: import("@/types/shared").ReviewComment];
  "switch-view": [v: "changes" | "history"];
}>();

const commitsLayout = ref<"unified" | "split">("unified");
const commitsStats = ref<{ added: number; deleted: number } | null>(null);

const LIST_PANEL_MIN_PX = PANEL_SIZES.list.min;
const LIST_PANEL_MAX_PX = PANEL_SIZES.list.max;
const clampListPanelPx = (value: number) =>
  Math.min(LIST_PANEL_MAX_PX, Math.max(LIST_PANEL_MIN_PX, value));

const panelWidth = inject<Ref<number>>("rightPanelWidth", ref(0));

const cached = readCachedPanelState();
const commitsList = usePanelResizeState({
  cacheKey: "commitsList",
  pxStateKey: "panel_commits_list_px",
  initialPx: clampListPanelPx(cached.commitsListPx ?? PANEL_SIZES.list.defaults.history),
  clamp: clampListPanelPx,
  visibleStateKey: "commits_list_visible",
  initialVisible: cached.commitsListVisible,
  writeCachedVisible: writeCachedCommitsListVisible,
  containerWidth: panelWidth,
});

watch(() => props.selection, () => {
  commitsStats.value = null;
  commitsList.dismissOverlay();
});

const commitsDiffFilePath = computed(() =>
  props.selection && props.rootDir ? `${props.rootDir}/${props.selection.relPath}` : null,
);

onMounted(async () => {
  const rpc = useRpc();
  try {
    const [commitsPx, commitsVis] = await Promise.all([
      rpc.request.getAppState({ key: "panel_commits_list_px" }),
      rpc.request.getAppState({ key: "commits_list_visible" }),
    ]);
    commitsList.applyPersisted(commitsPx, commitsVis);
  } catch {}
});

onUnmounted(() => {
  commitsList.dispose();
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden flex-1 min-h-0">
    <DiffPanelHeader
      :list-visible="commitsList.open.value"
      :rel-path="selection?.relPath ?? null"
      :commit-short-id="selection?.commitShortId ?? null"
      :stats="commitsStats"
      :layout="commitsLayout"
      view="history"
      @update:list-visible="commitsList.open.value = $event"
      @update:layout="commitsLayout = $event"
      @update:view="(v) => emit('switch-view', v)"
    />
    <div class="flex-1 min-h-0">
      <OverlaySidebarGroup :state="commitsList" :container-width="panelWidth">
        <template #sidebar>
          <HistoryPanel
            :working-dir="rootDir"
            :active-rel-path="selection?.relPath ?? null"
            :active-commit-id="selection?.commitId ?? null"
            class="h-full"
            @open-diff="(f, c, s) => emit('open-diff', f, c, s)"
          />
        </template>
        <template #content>
          <div v-if="selection && commitsDiffFilePath" class="flex flex-col h-full">
            <ReviewBar
              v-if="scopeKey && reviewTotal > 0"
              :scope-key="scopeKey"
              :directory-id="activeDirId"
              :cwd="activeCwd"
              @jump="emit('jump', $event)"
            />
            <DiffView
              :key="`commit:${selection.commitId}:${selection.relPath}`"
              :file-path="commitsDiffFilePath"
              :original="selection.original"
              :modified="selection.modified"
              :root-dir="rootDir"
              :layout="commitsLayout"
              :review-context="reviewContext"
              class="flex-1 min-h-0"
              @stats="(s) => (commitsStats = s)"
            />
          </div>
          <div v-else class="flex h-full items-center justify-center bg-sidebar">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><GitCompare /></EmptyMedia>
                <EmptyTitle>No Diff Selected</EmptyTitle>
                <EmptyDescription>Expand a commit and pick a file.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        </template>
      </OverlaySidebarGroup>
    </div>
  </div>
</template>
