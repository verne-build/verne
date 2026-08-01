<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { toast } from "vue-sonner";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "@lucide/vue";
import { useAgentInventory } from "@/composables/useAgentInventory";
import { useRpc } from "@/composables/useRpc";
import { openExternal } from "@/platform";
import type { AgentInventoryItem, AgentInventoryKey, McpAgentStatus } from "@/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

const MCP_KEYS = new Set<AgentInventoryKey>(["claude", "codex", "cursor", "opencode"]);

const inventory = useAgentInventory();
const { request } = useRpc();
const mcpStatuses = ref<Partial<Record<AgentInventoryKey, McpAgentStatus>>>({});
const manualCommands = ref<Partial<Record<AgentInventoryKey, string>>>({});
const expanded = ref(new Set<AgentInventoryKey>());
const busy = ref(new Set<AgentInventoryKey>());
const refreshing = ref(false);
let mcpRefreshGeneration = 0;
let disposed = false;

function shortenHome(path: string | null): string | null {
  if (!path) return null;
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

function detectionState(agent: AgentInventoryItem): { label: string; variant: BadgeVariant } {
  if (agent.discoveryStatus === "installed") return { label: "Detected", variant: "secondary" };
  if (agent.discoveryStatus === "missing") return { label: "Not Detected", variant: "outline" };
  return { label: "Check Failed", variant: "destructive" };
}

function updateState(agent: AgentInventoryItem): { label: string; variant: BadgeVariant } {
  if (agent.updateStatus === "outdated") return { label: "Update Available", variant: "default" };
  if (agent.updateStatus === "current") return { label: "Current", variant: "secondary" };
  return { label: "Update Unknown", variant: "outline" };
}

function mcpState(status: McpAgentStatus | undefined): { label: string; variant: BadgeVariant } {
  switch (status?.status) {
    case "registered": return { label: "MCP Installed", variant: "default" };
    case "needsApproval": return { label: "MCP Needs Approval", variant: "secondary" };
    case "detected": return { label: "MCP Not Installed", variant: "outline" };
    case "notDetected": return { label: "MCP Agent Not Detected", variant: "outline" };
    case "error": return { label: "MCP Check Failed", variant: "destructive" };
    default: return { label: "MCP Not Checked", variant: "outline" };
  }
}

const rows = computed(() => (inventory.snapshot.value?.agents ?? []).map((agent) => {
  const detection = detectionState(agent);
  const update = updateState(agent);
  const mcpStatus = mcpStatuses.value[agent.key];
  const mcp = mcpState(mcpStatus);
  return {
    ...agent,
    detectionLabel: detection.label,
    detectionVariant: detection.variant,
    updateLabel: update.label,
    updateVariant: update.variant,
    displayPath: shortenHome(agent.resolvedBinary),
    hasMcp: MCP_KEYS.has(agent.key),
    mcpStatus,
    mcpLabel: mcp.label,
    mcpVariant: mcp.variant,
  };
}));

const checkedAt = computed(() => {
  const value = inventory.snapshot.value?.checkedAt;
  if (!value) return "Not Yet Checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
});

function setBusy(key: AgentInventoryKey, value: boolean): void {
  const next = new Set(busy.value);
  if (value) next.add(key);
  else next.delete(key);
  busy.value = next;
}

function patchMcp(key: AgentInventoryKey, status: McpAgentStatus): void {
  mcpStatuses.value = { ...mcpStatuses.value, [key]: status };
}

async function refreshMcp(agents: readonly AgentInventoryItem[]): Promise<void> {
  const generation = ++mcpRefreshGeneration;
  const installed = agents.filter((agent) =>
    MCP_KEYS.has(agent.key) && agent.discoveryStatus === "installed",
  );
  const installedKeys = new Set(installed.map((agent) => agent.key));
  mcpStatuses.value = Object.fromEntries(
    Object.entries(mcpStatuses.value).filter(([key]) => installedKeys.has(key as AgentInventoryKey)),
  );
  installed.forEach((agent) => setBusy(agent.key, true));

  const results = await Promise.allSettled(
    installed.map((agent) => request.mcpAgentStatus({ agent: agent.key })),
  );
  if (disposed || generation !== mcpRefreshGeneration) return;

  const next = { ...mcpStatuses.value };
  results.forEach((result, index) => {
    const agent = installed[index]!;
    next[agent.key] = result.status === "fulfilled" ? result.value : {
      key: agent.key,
      displayName: agent.displayName,
      status: "error",
      detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
    setBusy(agent.key, false);
  });
  mcpStatuses.value = next;
}

async function refreshAll(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const next = await inventory.refresh();
    await refreshMcp(next.agents);
  } catch (error) {
    toast.error("Refresh Failed", { description: error instanceof Error ? error.message : String(error) });
  } finally {
    refreshing.value = false;
  }
}

async function checkMcp(agent: AgentInventoryItem): Promise<void> {
  setBusy(agent.key, true);
  try {
    patchMcp(agent.key, await request.mcpAgentStatus({ agent: agent.key }));
  } catch (error) {
    patchMcp(agent.key, {
      key: agent.key,
      displayName: agent.displayName,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setBusy(agent.key, false);
  }
}

async function installMcp(agent: AgentInventoryItem): Promise<void> {
  if (agent.discoveryStatus !== "installed") return;
  setBusy(agent.key, true);
  try {
    await request.mcpInstall({ agent: agent.key });
    patchMcp(agent.key, await request.mcpAgentStatus({ agent: agent.key }));
    toast.success("Installed Verne MCP");
  } catch (error) {
    toast.error("Install Failed", { description: error instanceof Error ? error.message : String(error) });
  } finally {
    setBusy(agent.key, false);
  }
}

async function removeMcp(agent: AgentInventoryItem): Promise<void> {
  setBusy(agent.key, true);
  try {
    await request.mcpUninstall({ agent: agent.key });
    patchMcp(agent.key, await request.mcpAgentStatus({ agent: agent.key }));
  } catch (error) {
    toast.error("Remove Failed", { description: error instanceof Error ? error.message : String(error) });
  } finally {
    setBusy(agent.key, false);
  }
}

async function ensureManualCommand(key: AgentInventoryKey): Promise<string> {
  if (manualCommands.value[key] != null) return manualCommands.value[key]!;
  try {
    const command = await request.mcpManualCommands({ agent: key });
    manualCommands.value = { ...manualCommands.value, [key]: command };
    return command;
  } catch (error) {
    manualCommands.value = { ...manualCommands.value, [key]: "" };
    toast.error("Manual Setup Failed", { description: error instanceof Error ? error.message : String(error) });
    return "";
  }
}

function toggleManual(key: AgentInventoryKey): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else {
    next.add(key);
    void ensureManualCommand(key);
  }
  expanded.value = next;
}

async function copyManualCommand(key: AgentInventoryKey): Promise<void> {
  const command = await ensureManualCommand(key);
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    toast.success("Install Commands Copied");
  } catch (error) {
    toast.error("Couldn’t Copy", { description: error instanceof Error ? error.message : String(error) });
  }
}

async function copyUpdateCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    toast.success("Update Command Copied");
  } catch (error) {
    toast.error("Couldn’t Copy", { description: error instanceof Error ? error.message : String(error) });
  }
}

watch(inventory.snapshot, (next) => {
  if (!refreshing.value) void refreshMcp(next?.agents ?? []);
}, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
  mcpRefreshGeneration += 1;
});
</script>

<template>
  <section aria-labelledby="agent-inventory-heading">
    <div class="mb-3 flex items-center justify-between gap-4">
      <div class="min-w-0">
        <h3 id="agent-inventory-heading" class="text-sm font-bold text-balance">Agent Inventory</h3>
        <p class="mt-0.5 text-xs text-muted-foreground text-pretty">
          Installed versions, available updates, and Verne MCP access.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="min-h-10 shrink-0 transition-transform active:scale-[0.96]"
        :disabled="refreshing"
        @click="refreshAll"
      >
        <Loader2 v-if="refreshing" class="size-3.5 animate-spin" />
        <RefreshCw v-else class="size-3.5" />
        Refresh
      </Button>
    </div>

    <Card class="!gap-0 overflow-hidden !py-0 bg-popover">
      <CardContent class="!p-0">
        <div v-if="rows.length === 0" class="px-6 py-8 text-center text-xs text-muted-foreground">
          {{ inventory.loading.value ? "Checking agents…" : "Agent inventory is unavailable." }}
        </div>

        <article
          v-for="agent in rows"
          :key="agent.key"
          :data-agent-key="agent.key"
          class="border-b border-border px-4 py-4 last:border-b-0"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h4 class="text-sm font-medium text-balance">{{ agent.displayName }}</h4>
                <Badge :variant="agent.detectionVariant" class="text-[10px]">
                  <Check v-if="agent.discoveryStatus === 'installed'" class="size-3" />
                  {{ agent.detectionLabel }}
                </Badge>
                <Badge :variant="agent.updateVariant" class="text-[10px]">{{ agent.updateLabel }}</Badge>
              </div>
              <p v-if="agent.displayPath" class="selectable-text mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {{ agent.displayPath }}
              </p>
            </div>

            <dl class="grid shrink-0 grid-cols-2 gap-x-4 text-right text-[11px]">
              <div>
                <dt class="text-muted-foreground">Current</dt>
                <dd class="font-medium">{{ agent.currentVersion ?? "—" }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">Latest</dt>
                <dd class="font-medium">{{ agent.latestVersion ?? "—" }}</dd>
              </div>
            </dl>
          </div>

          <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <Button
                v-if="agent.updateCommand"
                type="button"
                variant="ghost"
                size="xs"
                class="min-h-10 transition-transform active:scale-[0.96]"
                @click="copyUpdateCommand(agent.updateCommand)"
              >
                <Copy class="size-3.5" />
                Copy Update Command
              </Button>
              <Button
                v-else-if="agent.updateUrl"
                type="button"
                variant="ghost"
                size="xs"
                class="min-h-10 transition-transform active:scale-[0.96]"
                @click="openExternal(agent.updateUrl)"
              >
                <ExternalLink class="size-3.5" />
                View Installation Guide
              </Button>
            </div>

            <div v-if="agent.hasMcp" data-mcp-controls class="flex flex-wrap items-center justify-end gap-1">
              <Badge :variant="agent.mcpVariant" class="mr-1 text-[10px]">{{ agent.mcpLabel }}</Badge>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                class="min-h-10 min-w-10 transition-transform active:scale-[0.96]"
                :aria-label="expanded.has(agent.key) ? 'Hide Manual Setup' : 'Show Manual Setup'"
                :title="expanded.has(agent.key) ? 'Hide Manual Setup' : 'Show Manual Setup'"
                @click="toggleManual(agent.key)"
              >
                <ChevronDown v-if="expanded.has(agent.key)" class="size-3.5" />
                <ChevronRight v-else class="size-3.5" />
              </Button>
              <Button
                v-if="agent.mcpStatus?.status === 'registered' || agent.mcpStatus?.status === 'needsApproval'"
                type="button"
                variant="ghost"
                size="xs"
                class="min-h-10 transition-transform active:scale-[0.96]"
                :disabled="busy.has(agent.key)"
                @click="removeMcp(agent)"
              >
                <Loader2 v-if="busy.has(agent.key)" class="size-3.5 animate-spin" />
                <Trash2 v-else class="size-3.5" />
                Remove MCP
              </Button>
              <Button
                v-else-if="agent.mcpStatus?.status === 'detected' || agent.mcpStatus?.status === 'notDetected'"
                type="button"
                variant="secondary"
                size="xs"
                class="min-h-10 transition-transform active:scale-[0.96]"
                :disabled="busy.has(agent.key) || agent.discoveryStatus !== 'installed'"
                @click="installMcp(agent)"
              >
                <Loader2 v-if="busy.has(agent.key)" class="size-3.5 animate-spin" />
                Install MCP
              </Button>
              <Button
                v-else-if="agent.discoveryStatus !== 'installed'"
                type="button"
                variant="secondary"
                size="xs"
                class="min-h-10"
                disabled
              >
                Install MCP
              </Button>
              <Button
                v-else
                type="button"
                variant="ghost"
                size="xs"
                class="min-h-10 transition-transform active:scale-[0.96]"
                :disabled="busy.has(agent.key)"
                @click="checkMcp(agent)"
              >
                <Loader2 v-if="busy.has(agent.key)" class="size-3.5 animate-spin" />
                <Search v-else class="size-3.5" />
                Check MCP Status
              </Button>
            </div>
          </div>

          <p v-if="agent.mcpStatus?.detail" class="mt-2 text-xs text-destructive text-pretty">
            {{ agent.mcpStatus.detail }}
          </p>

          <div v-if="agent.hasMcp && expanded.has(agent.key)" class="mt-2 rounded-lg border border-border bg-muted/60 p-2">
            <div class="flex items-start gap-2">
              <pre class="selectable-text min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all p-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{{ manualCommands[agent.key] || "Loading…" }}</pre>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                class="min-h-10 min-w-10 transition-transform active:scale-[0.96]"
                aria-label="Copy Install Commands"
                title="Copy Install Commands"
                @click="copyManualCommand(agent.key)"
              >
                <Copy class="size-3.5" />
              </Button>
            </div>
          </div>
        </article>
      </CardContent>
    </Card>

    <p
      class="mt-3 min-h-4 text-[11px] text-muted-foreground tabular-nums"
      :title="inventory.snapshot.value?.checkedAt"
    >
      Last Checked: {{ checkedAt }}
      <span v-if="inventory.snapshot.value?.refreshError"> · Latest-version checks may be unavailable.</span>
    </p>
  </section>
</template>
