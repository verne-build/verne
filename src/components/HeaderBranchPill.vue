<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import { toast } from "vue-sonner";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { listen, type UnlistenFn } from "@/platform";
import { GitBranch as GitBranchIcon } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import BranchPickerDialog from "@/components/BranchPickerDialog.vue";

const store = useWorkspaceStore();
const { request } = useRpc();

const props = withDefaults(defineProps<{
  showSeparator?: boolean;
  compact?: boolean;
}>(), {
  showSeparator: true,
  compact: false,
});

const activeRoot = computed(() => store.activeRoot);
const isWorktree = computed(() => activeRoot.value?.scopeType === "agent_worktree");
const currentBranch = ref("");
const open = ref(false);
const renaming = ref(false);
const draftName = ref("");
const inputEl = ref<HTMLInputElement | null>(null);
const sizerEl = ref<HTMLSpanElement | null>(null);
const minTextWidth = ref(0);
const textWidth = ref(0);
let unlisten: UnlistenFn | null = null;

async function fetchBranchName() {
  const path = activeRoot.value?.path;
  if (!path) { currentBranch.value = ""; return; }
  try {
    currentBranch.value = await request.gitBranchName({ path });
  } catch {
    currentBranch.value = "";
  }
}

watch(activeRoot, () => {
  renaming.value = false;
  fetchBranchName();
}, { immediate: true });

watch(draftName, () => nextTick(measureInput));

onMounted(async () => {
  unlisten = await listen<string>("git-status-changed", (ev) => {
    if (ev.payload === activeRoot.value?.path) fetchBranchName();
  });
});
onUnmounted(() => { unlisten?.(); });

function handleClick(e: MouseEvent) {
  if (!activeRoot.value) return;
  if (isWorktree.value) {
    const span = (e.currentTarget as HTMLElement).querySelector("span");
    minTextWidth.value = span?.getBoundingClientRect().width ?? 0;
    startRename();
  } else {
    open.value = true;
  }
}

async function startRename() {
  draftName.value = currentBranch.value;
  renaming.value = true;
  await nextTick();
  measureInput();
  inputEl.value?.focus();
  inputEl.value?.select();
}

function measureInput() {
  if (sizerEl.value) textWidth.value = sizerEl.value.offsetWidth;
}

const inputWidthPx = computed(() => `${Math.max(textWidth.value, minTextWidth.value) + 12}px`);

async function commitRename() {
  if (!renaming.value) return;
  const next = draftName.value.trim();
  const prev = currentBranch.value;
  renaming.value = false;
  if (!next || next === prev) return;
  const path = activeRoot.value?.path;
  if (!path) return;
  try {
    await request.gitRenameBranch({ path, oldName: prev, newName: next });
    currentBranch.value = next;
  } catch (e) {
    toast.error("Rename failed", { description: e instanceof Error ? e.message : String(e) });
  }
}

function cancelRename() {
  renaming.value = false;
}
</script>

<template>
  <template v-if="activeRoot && currentBranch">
    <span v-if="props.showSeparator" class="text-muted-foreground/50 shrink-0 text-sm">/</span>
    <Button
      v-if="!renaming"
      variant="ghost"
      size="xs"
      :class="[
        'font-normal text-foreground/80 cursor-pointer hover:bg-transparent hover:text-foreground/80',
        props.compact
          ? 'h-6 max-w-[11rem] min-w-0 gap-1 rounded px-1.5 text-[11px] has-[>svg]:px-1.5'
          : 'gap-1.5 px-0 has-[>svg]:px-0',
      ]"
      @click="handleClick"
    >
      <GitBranchIcon :class="[props.compact ? 'size-3' : 'size-3.5', 'shrink-0']" />
      <span class="truncate">{{ currentBranch }}</span>
    </Button>
    <div
      v-else
      :class="['flex items-center gap-1', props.compact ? 'h-6' : 'h-7']"
    >
      <GitBranchIcon :class="[props.compact ? 'size-3' : 'size-3.5', 'shrink-0']" />
      <input
        ref="inputEl"
        v-model="draftName"
        :style="{ width: inputWidthPx }"
        class="bg-transparent rounded border border-input px-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
        spellcheck="false"
        autocomplete="off"
        @keydown.enter.prevent="commitRename"
        @keydown.escape.prevent="cancelRename"
        @blur="commitRename"
      />
      <span
        ref="sizerEl"
        class="invisible absolute -left-[9999px] top-0 text-xs whitespace-pre"
      >{{ draftName || " " }}</span>
    </div>

    <BranchPickerDialog
      v-if="activeRoot && !isWorktree"
      :open="open"
      :working-path="activeRoot.path"
      :current-branch="currentBranch"
      @update:open="(v: boolean) => (open = v)"
      @branch-changed="fetchBranchName"
    />
  </template>
</template>
