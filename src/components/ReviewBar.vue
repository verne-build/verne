<script setup lang="ts">
import { computed, ref, onMounted, watch } from "vue";
import { MessageSquare } from "@lucide/vue";
import { useDiffReview } from "@/composables/useDiffReview";
import { useRpc } from "@/composables/useRpc";
import type { ReviewComment } from "@/types/shared";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import FileIcon from "./FileIcon.vue";

const props = defineProps<{ scopeKey: string; directoryId: string; cwd: string }>();
const emit = defineEmits<{ jump: [comment: ReviewComment] }>();

const review = useDiffReview();
const { request } = useRpc();

const overall = ref("");
const sending = ref(false);
const requestOpen = ref(false);
const navOpen = ref(false);
const confirmingDiscard = ref(false);
let discardTimer: ReturnType<typeof setTimeout> | undefined;

// Set of paths still present in the working tree; null until first fetched.
// Comments on files no longer changed (committed/reverted) are filtered out.
const validPaths = ref<Set<string> | null>(null);

const navComments = computed(() => {
  const all = review.commentsInScope(props.scopeKey);
  const valid = validPaths.value;
  if (!valid) return all;
  return all.filter((c) => c.source !== "sourceControl" || valid.has(c.relPath));
});
// Count/files reflect only live comments (matches the dropdown + what's sent).
const summary = computed(() => ({
  total: navComments.value.length,
  files: new Set(navComments.value.map((c) => c.relPath)).size,
}));

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
  // Prune orphaned source-control comments (their file is no longer changed).
  for (const c of review.commentsInScope(props.scopeKey)) {
    if (c.source === "sourceControl" && !valid.has(c.relPath)) void review.removeComment(c.id);
  }
}

function onNavToggle(open: boolean) {
  navOpen.value = open;
  if (open) void refreshValidPaths();
}

onMounted(refreshValidPaths);
watch(() => [props.scopeKey, props.cwd], refreshValidPaths);

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

async function send() {
  if (sending.value) return;
  sending.value = true;
  try {
    await review.requestChanges(props.scopeKey, props.directoryId, props.cwd, overall.value);
    overall.value = "";
    requestOpen.value = false;
  } finally {
    sending.value = false;
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
  <div class="flex items-center justify-between gap-2 border-b border-border bg-secondary/40 px-3 py-1.5 text-xs">
    <Popover :open="navOpen" @update:open="onNavToggle">
      <PopoverTrigger as-child>
        <button class="flex items-center gap-1 text-muted-foreground hover:text-foreground" type="button">
          <MessageSquare class="size-3" />
          {{ summary.total }} comment{{ summary.total === 1 ? "" : "s" }}
          · {{ summary.files }} file{{ summary.files === 1 ? "" : "s" }}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-80 p-0">
        <ScrollArea class="max-h-72">
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
      </PopoverContent>
    </Popover>

    <div class="flex items-center gap-1">
      <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" @click="discard">
        {{ confirmingDiscard ? "Confirm Discard" : "Discard" }}
      </Button>
      <Popover v-model:open="requestOpen">
        <PopoverTrigger as-child>
          <Button size="sm" class="h-6 px-2 text-xs">Request Changes</Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-80">
          <p class="mb-1 text-xs font-medium">Send review to agent</p>
          <Textarea
            v-model="overall"
            rows="3"
            placeholder="Optional overall message (e.g. focus on error handling)…"
            class="text-xs"
          />
          <div class="mt-2 flex justify-end">
            <Button size="sm" class="h-7 px-3 text-xs" :disabled="sending" @click="send">
              {{ sending ? "Sending…" : "Send to Agent" }}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  </div>
</template>
