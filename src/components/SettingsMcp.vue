<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRpc } from "@/composables/useRpc";
import type { McpAgentStatus } from "@/types";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { toast } from "vue-sonner";
import { Check, ChevronDown, ChevronRight, Copy, Download, Loader2, Search, Trash2 } from "@lucide/vue";

const { request } = useRpc();

const agents = ref<McpAgentStatus[]>([]);
const commands = ref<Record<string, string>>({});
const expanded = ref<Set<string>>(new Set());
const busy = ref<Set<string>>(new Set());
const loading = ref(true);
let refreshGeneration = 0;

async function loadSupportedAgents() {
  const generation = ++refreshGeneration;
  try {
    const next = await request.mcpSupportedAgents({});
    if (generation !== refreshGeneration) return;
    agents.value = next.map((a) => ({ ...a, status: "unknown" as const }));
  } catch {
    if (generation !== refreshGeneration) return;
    agents.value = [];
  } finally {
    if (generation === refreshGeneration) loading.value = false;
  }
}

function toggle(key: string) {
  const next = new Set(expanded.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
    void ensureManualCommand(key);
  }
  expanded.value = next;
}

// Optimistically reflect a just-completed action so the row doesn't flip back to
// its old state during the ~1s status re-probe in refresh(); refresh reconciles.
function patchAgent(key: string, patch: Partial<McpAgentStatus>) {
  agents.value = agents.value.map((a) =>
    a.key === key ? { ...a, ...patch } : a,
  );
}

function setBusy(key: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(key); else next.delete(key);
  busy.value = next;
}

async function ensureManualCommand(key: string) {
  if (commands.value[key] != null) return;
  try {
    commands.value = {
      ...commands.value,
      [key]: await request.mcpManualCommands({ agent: key }),
    };
  } catch {
    commands.value = { ...commands.value, [key]: "" };
  }
}

async function checkInstallation(key: string) {
  setBusy(key, true);
  try {
    const status = await request.mcpAgentStatus({ agent: key });
    patchAgent(key, status);
  } catch (e) {
    patchAgent(key, {
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
    });
  } finally {
    setBusy(key, false);
  }
}

async function install(key: string) {
  setBusy(key, true);
  try {
    await request.mcpInstall({ agent: key });
    const status = await request.mcpAgentStatus({ agent: key });
    patchAgent(key, status);
    toast.success("Installed Verne MCP");
  } catch (e) {
    toast.error("Install failed", { description: e instanceof Error ? e.message : String(e) });
  } finally {
    setBusy(key, false);
  }
}

async function uninstall(key: string) {
  setBusy(key, true);
  try {
    await request.mcpUninstall({ agent: key });
    const status = await request.mcpAgentStatus({ agent: key });
    patchAgent(key, status);
  } catch (e) {
    toast.error("Remove failed", { description: e instanceof Error ? e.message : String(e) });
  } finally {
    setBusy(key, false);
  }
}

async function copy(key: string) {
  try {
    const text = commands.value[key] ?? (await request.mcpManualCommands({ agent: key }));
    await navigator.clipboard.writeText(text);
    toast.success("Install commands copied");
  } catch (e) {
    toast.error("Couldn't copy", { description: e instanceof Error ? e.message : String(e) });
  }
}

function statusLabel(s: McpAgentStatus): { text: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  switch (s.status) {
    case "unknown": return { text: "Not checked", variant: "outline" };
    case "registered": return { text: "Installed", variant: "default" };
    case "needsApproval": return { text: "Needs approval", variant: "secondary" };
    case "detected": return { text: "Not installed", variant: "outline" };
    case "error": return { text: "Error", variant: "destructive" };
    default: return { text: "Not detected", variant: "outline" };
  }
}

onMounted(loadSupportedAgents);
onBeforeUnmount(() => { refreshGeneration++; });
</script>

<template>
  <div>
    <div class="flex items-start justify-between gap-4 mb-1">
      <div>
        <h3 class="text-sm font-bold">Agent Access (MCP)</h3>
      </div>
    </div>

    <div v-if="loading" class="py-8 text-center text-xs text-muted-foreground">Loading supported agents…</div>

    <div v-else class="mt-3 flex flex-col divide-y divide-border rounded-md border border-border bg-popover">
      <div v-for="a in agents" :key="a.key" class="flex flex-col">
        <div class="flex items-center gap-3 px-3 py-2.5">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium">{{ a.displayName }}</div>
            <div v-if="a.detail" class="text-xs text-destructive truncate">{{ a.detail }}</div>
          </div>

          <Badge :variant="statusLabel(a).variant" class="text-[10px]">
            <Check v-if="a.status === 'registered'" class="size-3 mr-0.5" />
            {{ statusLabel(a).text }}
          </Badge>

          <div class="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              :title="expanded.has(a.key) ? 'Hide commands' : 'Show commands'"
              @click="toggle(a.key)"
            >
              <ChevronDown v-if="expanded.has(a.key)" class="size-3.5" />
              <ChevronRight v-else class="size-3.5" />
            </Button>

            <Button
              v-if="a.status === 'unknown' || a.status === 'error'"
              size="xs"
              variant="secondary"
              :disabled="busy.has(a.key)"
              @click="checkInstallation(a.key)"
            >
              <Loader2 v-if="busy.has(a.key)" class="size-3.5 mr-1 animate-spin" />
              <Search v-else class="size-3.5 mr-1" />
              Check installation
            </Button>

            <Button
              v-else
              variant="ghost"
              size="icon-xs"
              title="Check installation"
              :disabled="busy.has(a.key)"
              @click="checkInstallation(a.key)"
            >
              <Search class="size-3.5" />
            </Button>

            <Button
              v-if="a.status === 'registered' || a.status === 'needsApproval'"
              variant="ghost"
              size="icon-xs"
              title="Remove"
              :disabled="busy.has(a.key)"
              @click="uninstall(a.key)"
            >
              <Loader2 v-if="busy.has(a.key)" class="size-3.5 animate-spin" />
              <Trash2 v-else class="size-3.5" />
            </Button>
            <Button
              v-else-if="a.status === 'detected' || a.status === 'notDetected'"
              size="xs"
              variant="secondary"
              :disabled="busy.has(a.key) || a.status === 'notDetected'"
              @click="install(a.key)"
            >
              <Loader2 v-if="busy.has(a.key)" class="size-3.5 mr-1 animate-spin" />
              Install
            </Button>
          </div>
        </div>

        <div v-if="expanded.has(a.key)" class="px-3 pb-2.5">
          <div class="relative rounded-md bg-muted/60 border border-border">
            <pre class="selectable-text overflow-x-auto p-2.5 pr-9 text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap break-all">{{ commands[a.key] || "…" }}</pre>
            <Button
              variant="ghost"
              size="icon-xs"
              class="absolute top-1.5 right-1.5"
              title="Copy install commands"
              @click="copy(a.key)"
            >
              <Copy class="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <p class="text-[11px] text-muted-foreground mt-3">
      Expand a row to view or copy the manual setup commands.
    </p>
  </div>
</template>
