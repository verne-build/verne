<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { ChevronRight, ExternalLink, Loader2, RefreshCw } from "@lucide/vue";
import { useAgentInventory } from "@/composables/useAgentInventory";
import { useRpc } from "@/composables/useRpc";
import { openExternal } from "@/platform";
import type { AgentInventoryItem, AgentInventoryKey, McpAgentStatus } from "@/types";
import AgentInventoryRow from "./AgentInventoryRow.vue";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

const MCP_KEYS = new Set<AgentInventoryKey>(["claude", "codex", "cursor", "opencode"]);

const inventory = useAgentInventory();
const { request } = useRpc();
const mcpStatuses = ref<Partial<Record<AgentInventoryKey, McpAgentStatus>>>({});
const manualCommands = ref<Partial<Record<AgentInventoryKey, string>>>({});
const expanded = ref(new Set<AgentInventoryKey>());
const busyCounts = ref<Partial<Record<AgentInventoryKey, number>>>({});
const refreshing = ref(false);
const undetectedOpen = ref(false);
const operationOwners = new Map<AgentInventoryKey, number>();
const activeMutations = new Set<AgentInventoryKey>();
let nextOperationId = 0;
let disposed = false;

type McpOperation = {
  id: number;
  keys: readonly AgentInventoryKey[];
};

const agents = computed(() => inventory.snapshot.value?.agents ?? []);
const detected = computed(() => agents.value.filter((agent) => agent.discoveryStatus === "installed"));
const undetected = computed(() => agents.value.filter((agent) => agent.discoveryStatus !== "installed"));
const undetectedNames = computed(() => undetected.value.map((agent) => agent.displayName).join(", "));

/** True while any stage of a refresh is still resolving, local or pushed. */
const scanning = computed(() => refreshing.value || inventory.refreshing.value);

const checkedAt = computed(() => {
  const value = inventory.snapshot.value?.checkedAt;
  if (!value) return "Not Yet Checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
});

const busy = computed(() => new Set(
  Object.entries(busyCounts.value)
    .filter(([, count]) => count > 0)
    .map(([key]) => key as AgentInventoryKey),
));

const hasBusy = computed(() => busy.value.size > 0);

function beginOperation(keys: readonly AgentInventoryKey[]): McpOperation {
  const operation = { id: ++nextOperationId, keys };
  const next = { ...busyCounts.value };
  keys.forEach((key) => {
    operationOwners.set(key, operation.id);
    next[key] = (next[key] ?? 0) + 1;
  });
  busyCounts.value = next;
  return operation;
}

function owns(operation: McpOperation, key: AgentInventoryKey): boolean {
  return !disposed && operationOwners.get(key) === operation.id;
}

function finishOperation(operation: McpOperation): void {
  if (disposed) return;
  const next = { ...busyCounts.value };
  operation.keys.forEach((key) => {
    const count = (next[key] ?? 0) - 1;
    if (count > 0) next[key] = count;
    else delete next[key];
  });
  busyCounts.value = next;
}

function patchMcp(key: AgentInventoryKey, status: McpAgentStatus): void {
  mcpStatuses.value = { ...mcpStatuses.value, [key]: status };
}

async function refreshMcp(list: readonly AgentInventoryItem[]): Promise<void> {
  const supported = list.filter((agent) => MCP_KEYS.has(agent.key));
  const installed = list.filter((agent) =>
    MCP_KEYS.has(agent.key) && agent.discoveryStatus === "installed",
  );
  const operation = beginOperation(
    supported.filter((agent) => !activeMutations.has(agent.key)).map((agent) => agent.key),
  );
  const installedKeys = new Set(installed.map((agent) => agent.key));
  mcpStatuses.value = Object.fromEntries(
    Object.entries(mcpStatuses.value).filter(([key]) => installedKeys.has(key as AgentInventoryKey)),
  );
  const results = await Promise.allSettled(
    installed.map((agent) => request.mcpAgentStatus({ agent: agent.key })),
  );
  if (!disposed) {
    const next = { ...mcpStatuses.value };
    results.forEach((result, index) => {
      const agent = installed[index]!;
      if (!owns(operation, agent.key)) return;
      next[agent.key] = result.status === "fulfilled" ? result.value : {
        key: agent.key,
        displayName: agent.displayName,
        status: "error",
        detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
    mcpStatuses.value = next;
  }
  finishOperation(operation);
}

async function refreshAll(): Promise<void> {
  if (scanning.value || hasBusy.value) return;
  refreshing.value = true;
  try {
    const next = await inventory.refresh();
    if (disposed) return;
    await refreshMcp(next.agents);
  } catch (error) {
    if (!disposed)
      toast.error("Refresh Failed", { description: error instanceof Error ? error.message : String(error) });
  } finally {
    if (!disposed) refreshing.value = false;
  }
}

async function checkMcp(agent: AgentInventoryItem): Promise<void> {
  if (refreshing.value || busy.value.has(agent.key) || agent.discoveryStatus !== "installed") return;
  const operation = beginOperation([agent.key]);
  try {
    const status = await request.mcpAgentStatus({ agent: agent.key });
    if (owns(operation, agent.key)) patchMcp(agent.key, status);
  } catch (error) {
    if (owns(operation, agent.key)) patchMcp(agent.key, {
      key: agent.key,
      displayName: agent.displayName,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    finishOperation(operation);
  }
}

async function installMcp(agent: AgentInventoryItem): Promise<void> {
  if (refreshing.value || busy.value.has(agent.key) || agent.discoveryStatus !== "installed") return;
  const operation = beginOperation([agent.key]);
  activeMutations.add(agent.key);
  try {
    await request.mcpInstall({ agent: agent.key });
    if (!owns(operation, agent.key)) return;
    const status = await request.mcpAgentStatus({ agent: agent.key });
    if (!owns(operation, agent.key)) return;
    patchMcp(agent.key, status);
    toast.success("Installed Verne MCP");
  } catch (error) {
    if (owns(operation, agent.key))
      toast.error("Install Failed", { description: error instanceof Error ? error.message : String(error) });
  } finally {
    activeMutations.delete(agent.key);
    finishOperation(operation);
  }
}

async function removeMcp(agent: AgentInventoryItem): Promise<void> {
  if (refreshing.value || busy.value.has(agent.key)) return;
  const operation = beginOperation([agent.key]);
  activeMutations.add(agent.key);
  try {
    await request.mcpUninstall({ agent: agent.key });
    if (!owns(operation, agent.key)) return;
    const status = await request.mcpAgentStatus({ agent: agent.key });
    if (owns(operation, agent.key)) patchMcp(agent.key, status);
  } catch (error) {
    if (owns(operation, agent.key))
      toast.error("Remove Failed", { description: error instanceof Error ? error.message : String(error) });
  } finally {
    activeMutations.delete(agent.key);
    finishOperation(operation);
  }
}

function setMcp(agent: AgentInventoryItem, enabled: boolean): void {
  void (enabled ? installMcp(agent) : removeMcp(agent));
}

async function ensureManualCommand(key: AgentInventoryKey): Promise<string> {
  if (manualCommands.value[key] != null) return manualCommands.value[key]!;
  try {
    const command = await request.mcpManualCommands({ agent: key });
    if (disposed) return "";
    manualCommands.value = { ...manualCommands.value, [key]: command };
    return command;
  } catch (error) {
    if (disposed) return "";
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
  await copyText(command, "Install Commands Copied");
}

async function copyText(value: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    if (disposed) return;
    toast.success(success);
  } catch (error) {
    if (!disposed)
      toast.error("Couldn’t Copy", { description: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Streaming refresh republishes the snapshot many times per run; only a change
 * to the MCP-capable installed set is worth re-fanning status probes for.
 */
const mcpFingerprint = computed(() => detected.value
  .filter((agent) => MCP_KEYS.has(agent.key))
  .map((agent) => agent.key)
  .join(","));

watch(mcpFingerprint, () => {
  if (!refreshing.value) void refreshMcp(agents.value);
}, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
  nextOperationId += 1;
  operationOwners.clear();
  activeMutations.clear();
});
</script>

<template>
  <section aria-labelledby="agent-inventory-heading">
    <div class="mb-3 flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h3 id="agent-inventory-heading" class="text-sm font-bold text-balance">Agent Inventory</h3>
        <p class="mt-0.5 text-xs text-muted-foreground text-pretty">
          Installed versions, available updates, and Verne MCP access.
        </p>
        <p class="mt-1 text-[11px] text-muted-foreground tabular-nums" :title="inventory.snapshot.value?.checkedAt">
          Last Checked: {{ checkedAt }}
          <span v-if="inventory.snapshot.value?.refreshError" class="text-muted-foreground">
            · Detection failed · prior results may be stale.
          </span>
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="min-h-10 shrink-0 transition-transform active:scale-[0.96]"
        :disabled="scanning || hasBusy"
        @click="refreshAll"
      >
        <Loader2 v-if="scanning" class="size-3.5 animate-spin" />
        <RefreshCw v-else class="size-3.5" />
        {{ scanning ? "Checking…" : "Refresh" }}
      </Button>
    </div>

    <Card class="relative !gap-0 overflow-hidden !py-0 bg-popover">
      <div v-if="scanning" class="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
        <div class="inventory-scan h-full w-1/3 bg-primary/70" />
      </div>
      <CardContent class="!p-0 divide-y divide-border">
        <div v-if="agents.length === 0" class="px-6 py-8 text-center text-xs text-muted-foreground">
          {{ inventory.loading.value ? "Checking agents…" : "Agent inventory is unavailable." }}
        </div>
        <div v-else-if="detected.length === 0" class="px-6 py-8 text-center text-xs text-muted-foreground">
          No coding agents detected on your PATH.
        </div>

        <AgentInventoryRow
          v-for="agent in detected"
          :key="agent.key"
          :agent="agent"
          :has-mcp="MCP_KEYS.has(agent.key)"
          :mcp-status="mcpStatuses[agent.key]"
          :busy="busy.has(agent.key)"
          :locked="refreshing"
          :manual-open="expanded.has(agent.key)"
          :manual-command="manualCommands[agent.key]"
          @set-mcp="setMcp(agent, $event)"
          @check="checkMcp(agent)"
          @toggle-manual="toggleManual(agent.key)"
          @copy-update="copyText(agent.updateCommand!, 'Update Command Copied')"
          @open-guide="openExternal(agent.updateUrl!)"
          @copy-path="copyText(agent.resolvedBinary!, 'Path Copied')"
          @copy-manual="copyManualCommand(agent.key)"
        />
      </CardContent>
    </Card>

    <Collapsible v-if="undetected.length" v-model:open="undetectedOpen" class="mt-3">
      <CollapsibleTrigger
        data-undetected-toggle
        aria-label="Not Installed"
        class="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight class="size-3 shrink-0 transition-transform" :class="{ 'rotate-90': undetectedOpen }" />
        <span class="shrink-0">Not Installed ({{ undetected.length }})</span>
        <span class="truncate">· {{ undetectedNames }}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card class="mt-2 !gap-0 overflow-hidden !py-0 bg-popover">
          <CardContent class="!p-0 divide-y divide-border">
            <div
              v-for="agent in undetected"
              :key="agent.key"
              :data-agent-key="agent.key"
              class="flex items-center gap-3 px-4 py-2"
            >
              <span class="truncate text-sm">{{ agent.displayName }}</span>
              <span class="shrink-0 text-[11px] text-muted-foreground">
                {{ agent.errorCode === "discovery" ? "Detection failed" : "Not detected" }}
              </span>
              <Button
                v-if="agent.updateUrl"
                type="button"
                variant="ghost"
                size="xs"
                class="ml-auto shrink-0"
                @click="openExternal(agent.updateUrl)"
              >
                <ExternalLink class="size-3.5" />
                View Installation Guide
              </Button>
            </div>
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  </section>
</template>

<style scoped>
@keyframes inventory-scan {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}

.inventory-scan {
  animation: inventory-scan 1.1s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .inventory-scan {
    animation: none;
    opacity: 0.5;
  }
}
</style>
