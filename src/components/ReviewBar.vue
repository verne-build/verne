<script setup lang="ts">
import { computed, ref, onMounted, watch } from "vue";
import { MessageSquare, ChevronDown, Bot, Copy, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useDiffReview } from "@/composables/useDiffReview";
import { useRpc } from "@/composables/useRpc";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSettings } from "@/composables/useSettings";
import { useShortcuts } from "@/composables/useShortcuts";
import { getAgentIcon } from "@/composables/useAgentIcon";
import { formatReviewPrompt } from "@/lib/reviewPrompt";
import type { McpAgentInfo, ReviewComment } from "@/types/shared";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { Kbd } from "./ui/kbd";
import FileIcon from "./FileIcon.vue";

const props = defineProps<{ scopeKey: string; directoryId: string; cwd: string }>();
const emit = defineEmits<{ jump: [comment: ReviewComment] }>();

const review = useDiffReview();
const { request } = useRpc();
const store = useWorkspaceStore();
const { settings } = useSettings();
const shortcuts = useShortcuts();

const expanded = ref(false);
const sending = ref(false);
const confirmingDiscard = ref(false);
let discardTimer: ReturnType<typeof setTimeout> | undefined;

// Paths still present in the working tree; null until first fetched. Comments on
// files no longer changed (committed/reverted) are filtered out.
const validPaths = ref<Set<string> | null>(null);

const navComments = computed(() => {
  const all = review.commentsInScope(props.scopeKey);
  const valid = validPaths.value;
  if (!valid) return all;
  return all.filter((c) => c.source !== "sourceControl" || valid.has(c.relPath));
});
const total = computed(() => navComments.value.length);

// Running agents in the current directory — inject the review into one.
const runningAgents = computed(() =>
  store.agentsList("current").map(({ tab }) => {
    const rt = store.tabRuntime.get(tab.id);
    const agentType = (rt ? rt.agentType : tab.lastAgentType) ?? "claude";
    return { tabId: tab.id, agentType, label: tab.label };
  }),
);

// Launchable agents — spawn a fresh tab.
const newAgents = ref<McpAgentInfo[]>([]);
const defaultKeys = computed(() => shortcuts.displayKeys("new-agent-terminal"));

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
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

onMounted(async () => {
  void refreshValidPaths();
  try {
    newAgents.value = await request.mcpSupportedAgents({});
  } catch {
    newAgents.value = [];
  }
});
watch(() => [props.scopeKey, props.cwd], refreshValidPaths);

async function sendToNew(agentType: string) {
  if (sending.value) return;
  sending.value = true;
  try {
    await review.sendReviewToNewAgent(props.scopeKey, props.directoryId, props.cwd, agentType);
  } finally {
    sending.value = false;
  }
}
async function sendToTab(directoryId: string, tabId: string) {
  if (sending.value) return;
  sending.value = true;
  try {
    await review.sendReviewToTab(props.scopeKey, directoryId, tabId);
  } finally {
    sending.value = false;
  }
}

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
        Comments {{ total }}
        <ChevronDown class="size-3 transition-transform" :class="expanded ? 'rotate-180' : ''" />
      </button>

      <div class="flex items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button size="icon-xs" variant="ghost" :disabled="sending" title="Send to agent">
              <Bot />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <template v-if="runningAgents.length">
              <DropdownMenuLabel>Open Agents</DropdownMenuLabel>
              <DropdownMenuItem
                v-for="a in runningAgents"
                :key="a.tabId"
                @select="sendToTab(directoryId, a.tabId)"
              >
                <img :src="getAgentIcon(a.agentType)" class="size-4" alt="" />
                <span class="truncate">{{ titleCase(a.agentType) }}</span>
                <span class="truncate text-muted-foreground">· {{ a.label }}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </template>
            <DropdownMenuLabel>New Agent</DropdownMenuLabel>
            <DropdownMenuItem v-for="a in newAgents" :key="a.key" @select="sendToNew(a.key)">
              <img :src="getAgentIcon(a.key)" class="size-4" alt="" />
              <span class="flex-1 truncate">{{ a.displayName }}</span>
              <Kbd v-if="a.key === settings.defaultAgent && defaultKeys.length" variant="outline">
                {{ defaultKeys.join("") }}
              </Kbd>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
