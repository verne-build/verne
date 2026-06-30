<script setup lang="ts">
import { computed, ref, nextTick, onMounted } from "vue";
import MarkdownIt from "markdown-it";
import { Send, Pencil, Trash2, Loader2 } from "@lucide/vue";
import { useDiffReview } from "@/composables/useDiffReview";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Textarea } from "./ui/textarea";
import { Kbd } from "./ui/kbd";
import SendToAgentMenu from "./SendToAgentMenu.vue";

const props = defineProps<{ commentId: string }>();
const emit = defineEmits<{ clearSelection: [] }>();

const review = useDiffReview();
const comment = computed(() => review.commentById(props.commentId));
const editing = ref(false);
const draft = ref("");
const textareaRef = ref<InstanceType<typeof Textarea> | null>(null);

// "Comment" for a brand-new (never-saved) comment; "Save" when editing an
// existing one. Driven by the persisted body, not the live draft.
const isNew = computed(() => !comment.value?.body);

// Raw HTML disabled, so the body renders as escaped/trusted markup.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const bodyHtml = computed(() => {
  const b = comment.value?.body?.trim();
  return b ? md.render(b) : "";
});

const rangeLabel = computed(() => {
  const c = comment.value;
  if (!c) return "";
  return c.startLine === c.endLine ? `Line ${c.startLine}` : `Lines ${c.startLine}-${c.endLine}`;
});

function focusInput() {
  nextTick(() => (textareaRef.value?.$el as HTMLTextAreaElement | undefined)?.focus());
}

function startEdit() {
  draft.value = comment.value?.body ?? "";
  editing.value = true;
  focusInput();
}

async function save() {
  const body = draft.value.trim();
  emit("clearSelection");
  if (!body) {
    await review.removeComment(props.commentId);
    return;
  }
  await review.updateComment(props.commentId, body);
  editing.value = false;
}

async function cancel() {
  emit("clearSelection");
  // An unsaved (empty-body) draft is discarded entirely on cancel.
  if (!comment.value?.body) {
    await review.removeComment(props.commentId);
    return;
  }
  editing.value = false;
}

async function remove() {
  emit("clearSelection");
  await review.removeComment(props.commentId);
}

function onKeydown(e: KeyboardEvent) {
  // Enter submits; Shift+Enter inserts a newline.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (draft.value.trim()) void save();
  } else if (e.key === "Escape") {
    e.preventDefault();
    void cancel();
  }
}

// New comments start empty → open straight into edit mode.
onMounted(() => { if (!comment.value?.body) startEdit(); });
</script>

<template>
  <Card v-if="comment" class="my-1 gap-1 rounded-md border-border bg-card px-2 py-2 font-sans text-xs shadow-none">
    <div class="flex items-center gap-2">
      <span class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ rangeLabel }}</span>
    </div>

    <template v-if="editing">
      <Textarea
        ref="textareaRef"
        v-model="draft"
        rows="3"
        class="min-h-0 resize-none p-1.5 text-xs"
        placeholder="Leave a comment…"
        @keydown="onKeydown"
      />
      <div class="flex items-center justify-end gap-1">
        <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" @click="cancel">Cancel</Button>
        <Button size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="!draft.trim()" @click="save">
          {{ isNew ? "Comment" : "Save" }}
          <!-- This button is the primary (light/inverse) surface, so the page's
               muted token would invert against it. Use the button's own
               foreground token for a subtle filled chip that adapts to theme. -->
          <Kbd class="bg-primary-foreground/15 text-primary-foreground">↵</Kbd>
        </Button>
      </div>
    </template>

    <template v-else>
      <!-- Safe: MarkdownIt has raw HTML disabled (html:false); body is escaped/trusted. v-html allowed for this file in eslint.config.js. -->
      <div v-if="bodyHtml" v-html="bodyHtml" class="text-xs leading-snug [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_p]:my-0.5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-1.5 [&_ul]:my-0.5 [&_ul]:list-disc [&_ul]:pl-4" />
      <div class="flex items-center justify-end gap-0.5">
        <SendToAgentMenu :scope-key="comment.scopeKey">
          <template #trigger="{ sending }">
            <Button size="icon-xs" variant="ghost" :disabled="sending" title="Send to agent">
              <Loader2 v-if="sending" class="animate-spin" />
              <Send v-else />
            </Button>
          </template>
        </SendToAgentMenu>
        <Button size="icon-xs" variant="ghost" title="Edit" @click="startEdit">
          <Pencil />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Delete" @click="remove">
          <Trash2 />
        </Button>
      </div>
    </template>
  </Card>
</template>
