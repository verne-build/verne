<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from "vue";
import { Send, Copy, Check, Trash2, Loader2, MoreHorizontal } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useDiffReview } from "@/composables/useDiffReview";
import { useRpc } from "@/composables/useRpc";
import { ask } from "@/platform";
import { formatReviewPrompt } from "@/lib/reviewPrompt";
import type { ReviewComment } from "@/types/shared";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import SendToAgentMenu from "./SendToAgentMenu.vue";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import FileIcon from "./FileIcon.vue";

const props = defineProps<{ scopeKey: string; cwd: string }>();
const emit = defineEmits<{ jump: [comment: ReviewComment] }>();

const review = useDiffReview();
const { request } = useRpc();

const expanded = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

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

// Comments grouped by file: file header + its comments ordered by line.
const commentsByFile = computed(() => {
  const groups = new Map<string, ReviewComment[]>();
  for (const c of navComments.value) {
    const arr = groups.get(c.relPath);
    if (arr) arr.push(c);
    else groups.set(c.relPath, [c]);
  }
  return [...groups.entries()].map(([relPath, comments]) => ({
    relPath,
    name: fileName(relPath),
    comments: comments.slice().sort((a, b) => a.startLine - b.startLine),
  }));
});

function fileName(relPath: string): string {
  return relPath.split("/").pop() || relPath;
}
function previewOf(c: ReviewComment): string {
  const txt = c.body.trim();
  return txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
}
function rangeOf(c: ReviewComment): string {
  return c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`;
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
onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});

async function copyComments() {
  const text = formatReviewPrompt(navComments.value);
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    toast.success("Copied review to clipboard");
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    toast.error("Couldn't copy review");
  }
}

async function discard() {
  const n = total.value;
  const ok = await ask("Discard Comments?", {
    detail: `${n} review comment${n === 1 ? "" : "s"} will be permanently deleted.`,
    confirmLabel: "Discard",
  });
  if (ok) void review.clearScope(props.scopeKey);
}
</script>

<template>
  <div class="border-b border-border bg-sidebar text-xs">
    <div class="flex items-center justify-between gap-2 py-1.5 pl-3 pr-1">
      <button
        type="button"
        class="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
        @click="expanded = !expanded"
      >
        <span
          class="size-0 border-l-[5px] border-l-current border-y-[3.5px] border-y-transparent transition-transform"
          :class="{ 'rotate-90': expanded }"
        />
        Comments
        {{ total }}
      </button>

      <TooltipProvider :delay-duration="300">
        <div class="flex shrink-0 items-center">
          <SendToAgentMenu :scope-key="scopeKey">
            <template #trigger="{ sending }">
              <Button
                size="icon-xs"
                variant="ghost"
                class="text-muted-foreground hover:text-foreground"
                :disabled="sending"
              >
                <Loader2 v-if="sending" class="size-3.5 animate-spin" />
                <Send v-else class="size-3.5" />
              </Button>
            </template>
          </SendToAgentMenu>

          <DropdownMenu>
            <!-- Wrapper div is the dropdown trigger (click); the button inside
                 is the tooltip trigger (hover). Both as-child on one element
                 makes reka merge them and the dropdown clobbers the tooltip. -->
            <DropdownMenuTrigger as-child>
              <div class="inline-flex">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      class="text-muted-foreground hover:text-foreground"
                    >
                      <MoreHorizontal class="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">More</TooltipContent>
                </Tooltip>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @select="copyComments">
                <Check v-if="copied" />
                <Copy v-else />
                Copy Comments
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" @select="discard">
                <Trash2 />
                Discard Comments
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TooltipProvider>
    </div>

    <ScrollArea v-if="expanded" class="max-h-72 border-t border-border">
      <div class="px-1 py-1">
        <div v-for="group in commentsByFile" :key="group.relPath" class="mb-1">
          <div
            class="flex h-6 items-center gap-1.5 rounded-md px-2"
            :title="group.relPath"
          >
            <FileIcon :name="group.name" :size="14" />
            <span class="min-w-0 flex-1 truncate text-xs text-foreground">{{ group.name }}</span>
          </div>
          <button
            v-for="c in group.comments"
            :key="c.id"
            type="button"
            class="mt-0.5 flex h-6 w-full items-center gap-2 rounded-md pl-[26px] pr-2 text-left hover:bg-border/25"
            @click="emit('jump', c)"
          >
            <span class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ rangeOf(c) }}</span>
            <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{{ previewOf(c) }}</span>
          </button>
        </div>
        <div v-if="commentsByFile.length === 0" class="px-3 py-2 text-[11px] text-muted-foreground">
          No comments on current changes.
        </div>
      </div>
    </ScrollArea>
  </div>
</template>
