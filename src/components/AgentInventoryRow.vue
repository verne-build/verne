<script setup lang="ts">
import { computed } from "vue";
import { ArrowRight, Copy, Ellipsis, ExternalLink, Loader2, TriangleAlert } from "@lucide/vue";
import type { AgentInventoryItem, McpAgentStatus } from "@/types";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";

const props = defineProps<{
  agent: AgentInventoryItem;
  hasMcp: boolean;
  mcpStatus: McpAgentStatus | undefined;
  busy: boolean;
  /** A whole-inventory refresh is running; row mutations are held off. */
  locked: boolean;
  manualOpen: boolean;
  manualCommand: string | undefined;
}>();

const emit = defineEmits<{
  setMcp: [enabled: boolean];
  check: [];
  toggleManual: [];
  copyUpdate: [];
  openGuide: [];
  copyManual: [];
  copyPath: [];
}>();

const displayPath = computed(() => props.agent.resolvedBinary
  ?.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
  .replace(/^\/home\/[^/]+(?=\/|$)/, "~") ?? null);

const outdated = computed(() =>
  props.agent.updateStatus === "outdated" && props.agent.latestVersion !== null);

/** Skeletons stand in only where no value exists yet — a warm row never flickers. */
const currentPending = computed(() =>
  props.agent.pendingPhase !== null && props.agent.currentVersion === null);
const latestPending = computed(() =>
  props.agent.pendingPhase === "latest" && props.agent.latestVersion === null);

type Tone = "accent" | "muted" | "warn";

type Note = { label: string; tone: Tone; detail?: string };

/** Inventory state. One line, right of the path. */
const status = computed<Note | null>(() => {
  const { agent } = props;
  if (agent.errorCode === "discovery") return { label: "Detection failed", tone: "warn" };
  if (agent.errorCode === "version") {
    return { label: "Version check failed", tone: "warn", detail: "Verne could not read this agent's version." };
  }
  if (agent.errorCode === "latest") {
    return { label: "Latest check failed", tone: "warn", detail: "Verne could not reach the release feed." };
  }
  if (outdated.value) return { label: "Update available", tone: "accent" };
  return null;
});

/** MCP state is orthogonal to inventory state, so it gets its own line. */
const mcpNote = computed<Note | null>(() => {
  const status = props.mcpStatus;
  if (status?.status === "needsApproval") return { label: "Approve Verne MCP in the agent", tone: "muted" };
  if (status?.status === "error") {
    return { label: `MCP check failed — ${status.detail ?? "unknown error"}`, tone: "warn" };
  }
  return null;
});

const toneClass: Record<Tone, string> = {
  accent: "text-primary",
  muted: "text-muted-foreground",
  warn: "text-muted-foreground",
};

const mcpKnown = computed(() => props.mcpStatus !== undefined);
const mcpOn = computed(() =>
  props.mcpStatus?.status === "registered" || props.mcpStatus?.status === "needsApproval");
const mcpDisabled = computed(() =>
  props.locked || props.busy || !mcpKnown.value || props.agent.discoveryStatus !== "installed");
</script>

<template>
  <article
    :data-agent-key="agent.key"
    class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-muted/30"
  >
    <h4 class="truncate text-sm font-medium">{{ agent.displayName }}</h4>

    <div class="flex items-center justify-end gap-3">
      <div data-version-cell class="flex items-center gap-1.5 font-mono text-xs tabular-nums">
        <Skeleton v-if="currentPending" class="h-3 w-14" />
        <span v-else :class="outdated ? 'text-muted-foreground' : ''">{{ agent.currentVersion ?? "—" }}</span>
        <template v-if="outdated">
          <ArrowRight class="size-3 text-muted-foreground" />
          <span class="text-primary">{{ agent.latestVersion }}</span>
        </template>
        <Skeleton v-else-if="latestPending" class="h-3 w-10" />
      </div>

      <div v-if="hasMcp" data-mcp-controls class="flex items-center gap-1.5">
        <Loader2 v-if="busy" class="size-3.5 animate-spin text-muted-foreground" />
        <Skeleton v-else-if="!mcpKnown" class="h-[1.15rem] w-8 rounded-full" />
        <Switch
          v-else
          :model-value="mcpOn"
          :disabled="mcpDisabled"
          aria-label="Verne MCP"
          title="Verne MCP"
          @update:model-value="emit('setMcp', $event)"
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            class="size-7 text-muted-foreground"
            aria-label="More Actions"
          >
            <Ellipsis class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52">
          <DropdownMenuItem v-if="agent.updateCommand" @select="emit('copyUpdate')">
            <Copy class="size-3.5" />
            Copy Update Command
          </DropdownMenuItem>
          <DropdownMenuItem v-if="agent.updateUrl" @select="emit('openGuide')">
            <ExternalLink class="size-3.5" />
            View Installation Guide
          </DropdownMenuItem>
          <DropdownMenuItem v-if="displayPath" @select="emit('copyPath')">
            <Copy class="size-3.5" />
            Copy Path
          </DropdownMenuItem>
          <template v-if="hasMcp">
            <DropdownMenuSeparator />
            <DropdownMenuItem
              :disabled="locked || busy || agent.discoveryStatus !== 'installed'"
              @select="emit('check')"
            >
              Check MCP Status
            </DropdownMenuItem>
            <DropdownMenuItem @select="emit('toggleManual')">
              {{ manualOpen ? "Hide Manual Setup" : "Manual Setup" }}
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <p v-if="displayPath" class="selectable-text truncate font-mono text-[11px] text-muted-foreground">
      {{ displayPath }}
    </p>
    <p v-else class="text-[11px] text-muted-foreground">Not on PATH</p>

    <p
      v-if="status"
      class="flex items-center justify-end gap-1 text-[11px]"
      :class="toneClass[status.tone]"
      :title="status.detail"
    >
      <TriangleAlert v-if="status.tone === 'warn'" class="size-3" />
      {{ status.label }}
    </p>
    <span v-else />

    <p
      v-if="mcpNote"
      class="col-span-2 flex items-center gap-1 text-[11px]"
      :class="toneClass[mcpNote.tone]"
    >
      <TriangleAlert v-if="mcpNote.tone === 'warn'" class="size-3 shrink-0" />
      {{ mcpNote.label }}
    </p>

    <div v-if="manualOpen" class="col-span-2 mt-1 rounded-lg border border-border bg-muted/60 p-2">
      <div class="flex items-start gap-2">
        <pre class="selectable-text min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all p-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{{ manualCommand || "Loading…" }}</pre>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          class="size-7 shrink-0"
          aria-label="Copy Install Commands"
          title="Copy Install Commands"
          @click="emit('copyManual')"
        >
          <Copy class="size-3.5" />
        </Button>
      </div>
    </div>
  </article>
</template>
