<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useRpc } from "@/composables/useRpc";
import { useWorkspaceStore } from "@/stores/workspace";
import { useDiffReview } from "@/composables/useDiffReview";
import { useSettings } from "@/composables/useSettings";
import { useShortcuts } from "@/composables/useShortcuts";
import { getAgentIcon } from "@/composables/useAgentIcon";
import type { McpAgentInfo } from "@/types/shared";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { Kbd } from "./ui/kbd";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

// Sends the whole scope's review to an agent. Reused by the review bar and by
// each saved comment box, so the same dropdown is reachable from anywhere.
// Directory/cwd come from the active scope (store.activeRoot) rather than props,
// so the comment-box island can mount it without threading them through.
const props = defineProps<{ scopeKey: string }>();

const { request } = useRpc();
const store = useWorkspaceStore();
const review = useDiffReview();
const { settings } = useSettings();
const shortcuts = useShortcuts();

const sending = ref(false);
const newAgents = ref<McpAgentInfo[]>([]);
const defaultKeys = computed(() => shortcuts.displayKeys("new-agent-terminal"));

// Running agents in the current directory — inject the review into one.
const runningAgents = computed(() =>
  store.agentsList("current").map(({ tab }) => {
    const rt = store.tabRuntime.get(tab.id);
    const agentType = (rt ? rt.agentType : tab.lastAgentType) ?? "claude";
    return { tabId: tab.id, agentType, label: tab.label };
  }),
);

onMounted(async () => {
  try {
    newAgents.value = await request.mcpSupportedAgents({});
  } catch {
    newAgents.value = [];
  }
});

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function sendToNew(agentType: string) {
  if (sending.value) return;
  sending.value = true;
  try {
    await review.sendReviewToNewAgent(
      props.scopeKey,
      store.activeRoot?.scopeId ?? "",
      store.activeRoot?.path ?? "",
      agentType,
    );
  } finally {
    sending.value = false;
  }
}
async function sendToTab(tabId: string) {
  if (sending.value) return;
  sending.value = true;
  try {
    await review.sendReviewToTab(props.scopeKey, store.activeRoot?.scopeId ?? "", tabId);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <!-- The dropdown trigger and the tooltip trigger must sit on DIFFERENT
       elements — both as-child on one button makes reka merge them and the
       dropdown clobbers the tooltip's hover listeners. So the wrapper div is the
       dropdown trigger (click), and the button inside is the tooltip trigger
       (hover); the click bubbles from button → div to open the menu. -->
  <TooltipProvider :delay-duration="300">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <div class="inline-flex">
          <Tooltip>
            <TooltipTrigger as-child>
              <slot name="trigger" :sending="sending" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Send to Agent</TooltipContent>
          </Tooltip>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-56">
          <template v-if="runningAgents.length">
            <DropdownMenuLabel>Existing Agents</DropdownMenuLabel>
            <DropdownMenuItem v-for="a in runningAgents" :key="a.tabId" @select="sendToTab(a.tabId)">
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
  </TooltipProvider>
</template>
