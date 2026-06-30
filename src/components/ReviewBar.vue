<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from "vue";
import { MessageSquare, ChevronDown, Send, Copy, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useDiffReview } from "@/composables/useDiffReview";
import { useRpc } from "@/composables/useRpc";
import { formatReviewPrompt } from "@/lib/reviewPrompt";
import type { ReviewComment } from "@/types/shared";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import SendToAgentMenu from "./SendToAgentMenu.vue";
import FileIcon from "./FileIcon.vue";

const props = defineProps<{ scopeKey: string; cwd: string }>();
const emit = defineEmits<{ jump: [comment: ReviewComment] }>();

const review = useDiffReview();
const { request } = useRpc();

const expanded = ref(false);
const confirmingDiscard = ref(false);
let discardTimer: ReturnType<typeof setTimeout> | undefined;

// Paths still present in the working tree; null until first fetched. Comments on
// files no longer changed (committed/reverted) are filtered out.
const validPaths = ref<Set<string> | null>(null);

const navComments = computed(() => {
  // Review is working-changes-only: ignore any non-sourceControl (e.g. legacy
  // commit-scoped) comments, and drop sourceControl ones whose file is no
  // longer in the working tree.
  const scOnly = review.commentsInScope(props.scopeKey).filter((c) => c.source === "sourceControl");
  const valid = validPaths.value;
  if (!valid) return scOnly;
  return scOnly.filter((c) => valid.has(c.relPath));
});
const total = computed(() => navComments.value.length);

function fileName(relPath: string): string {
  return relPath.split("/").pop() || relPath;
}
function previewOf(c: ReviewComment): string {
  const txt = c.body.trim();
  return txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
}
function rangeOf(c: ReviewComment): string {
  return c.startLine === c.endLine ? `:${c.startLine}` : `:${c.startLine}-${c.endLine}`;
}

async function refreshValidPaths() {
  let valid: Set<string>;
  try {
    const s = await request.gitStatus({ path: props.cwd });
    valid = new Set([...s.staged, ...s.unstaged, ...s.untracked].map((e) => e.path));
  } catch {
    validPaths.value = null; // can't tell → don't filter
    return;
  }
  validPaths.value = valid;
  for (const c of review.commentsInScope(props.scopeKey)) {
    if (c.source === "sourceControl" && !valid.has(c.relPath)) void review.removeComment(c.id);
  }
}

onMounted(refreshValidPaths);
watch(() => [props.scopeKey, props.cwd], refreshValidPaths);
watch(expanded, (v) => { if (v) void refreshValidPaths(); });
onUnmounted(() => { if (discardTimer) clearTimeout(discardTimer); });

async function copyComments() {
  const text = formatReviewPrompt(navComments.value);
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Review copied to clipboard");
  } catch {
    toast.error("Couldn't copy review");
  }
}

function discard() {
  if (!confirmingDiscard.value) {
    confirmingDiscard.value = true;
    discardTimer = setTimeout(() => (confirmingDiscard.value = false), 3000);
    return;
  }
  if (discardTimer) clearTimeout(discardTimer);
  confirmingDiscard.value = false;
  void review.clearScope(props.scopeKey);
}
</script>

<template>
  <div class="border-b border-border bg-secondary/40 text-xs">
    <div class="flex items-center justify-between gap-2 px-3 py-1.5">
      <button
        type="button"
        class="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        @click="expanded = !expanded"
      >
        <MessageSquare class="size-3" />
        {{ total }}
        <ChevronDown class="size-3 transition-transform" :class="expanded ? 'rotate-180' : ''" />
      </button>

      <div class="flex items-center gap-0.5">
        <SendToAgentMenu :scope-key="scopeKey">
          <template #trigger="{ sending }">
            <Button size="icon-xs" variant="ghost" :disabled="sending" title="Send to agent">
              <Send />
            </Button>
          </template>
        </SendToAgentMenu>

        <Button size="icon-xs" variant="ghost" title="Copy comments" @click="copyComments">
          <Copy />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          :class="confirmingDiscard ? 'text-red-500' : ''"
          :title="confirmingDiscard ? 'Click again to discard' : 'Discard comments'"
          @click="discard"
        >
          <Trash2 />
        </Button>
      </div>
    </div>

    <ScrollArea v-if="expanded" class="max-h-72 border-t border-border">
      <ul class="py-1">
        <li v-for="c in navComments" :key="c.id">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-accent"
            :title="c.relPath"
            @click="emit('jump', c)"
          >
            <span class="flex w-full items-center gap-1.5">
              <FileIcon :name="fileName(c.relPath)" :size="14" />
              <span class="truncate text-xs">{{ fileName(c.relPath) }}</span>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ rangeOf(c) }}</span>
            </span>
            <span v-if="previewOf(c)" class="w-full truncate text-[11px] text-muted-foreground">{{ previewOf(c) }}</span>
          </button>
        </li>
        <li v-if="navComments.length === 0" class="px-3 py-2 text-[11px] text-muted-foreground">
          No comments on current changes.
        </li>
      </ul>
    </ScrollArea>
  </div>
</template>
