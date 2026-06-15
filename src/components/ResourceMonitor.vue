<script setup lang="ts">
import { ref, computed, onUnmounted } from "vue";
import { useRpc } from "../composables/useRpc";
import {
  getAttachedTerminalCount,
  getCachedTerminalCount,
  getMountedTerminalViewCount,
  getTerminalResizeObserverCount,
  getWebGLContextCount,
} from "../composables/useTerminal";
import { useFilePanelTabs } from "../composables/useFilePanelTabs";
import { useWorkspaceStore } from "../stores/workspace";
import { collectPaneIds } from "../lib/paneLayout";
import type { DebugMetrics, ProcessBreakdown, ResourceUsage } from "@/types/shared";
import {
  Cpu,
  MemoryStick,
  Bot,
  SquareTerminal,
  Blocks,
  Monitor,
  FileText,
} from "@lucide/vue";
import { Button } from "./ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";

const store = useWorkspaceStore();
const { fileTabs } = useFilePanelTabs(() => store.activeRoot);
const editorTabCount = computed(() => fileTabs.value.length);

// Tabs = pills (groups); Panes = live PTYs. usage.tabCount from the backend is
// actually the PTY/session count (one per pane), so it maps to Panes now.
const tabCount = computed(() =>
  Object.values(store.tabGroupsByDirectory).reduce((n, gs) => n + gs.length, 0),
);

const usage = ref<ResourceUsage | null>(null);
const webglContexts = ref(0);
const debugMetrics = ref<DebugMetrics | null>(null);
const cachedTerminals = ref(0);
const attachedTerminals = ref(0);
const mountedTerminalViews = ref(0);
const terminalResizeObservers = ref(0);
const isDev = import.meta.env.DEV;

// Core rows (App/Daemon/LSP) carry no tabId; pane rows do.
const coreProcesses = computed(() =>
  debugMetrics.value?.processBreakdown.filter((p) => !p.tabId) ?? []
);

interface PaneProcRow { label: string; ram: number; cpu: number }
interface TabProcGroup { key: string; name: string; ram: number; cpu: number; panes: PaneProcRow[] }

// What's running in a pane (agent or foreground command), for the indented row.
function paneProcLabel(p: ProcessBreakdown): string {
  const rt = p.tabId ? store.tabRuntime.get(p.tabId) : undefined;
  const a = rt?.agentType;
  if (a) return a.charAt(0).toUpperCase() + a.slice(1);
  if (rt?.foregroundCommand) return rt.foregroundCommand;
  return p.name.replace(/^Tab:\s*/, "");
}

// Pane processes grouped under their owning tab, preserving first-seen order.
const tabProcessGroups = computed<TabProcGroup[]>(() => {
  const procs = debugMetrics.value?.processBreakdown.filter((p) => p.tabId) ?? [];
  const map = new Map<string, TabProcGroup>();
  const order: string[] = [];
  // paneId → { id, name } for every pane in every group, built once (O(M)).
  const paneToGroup = new Map<string, { id: string; name: string }>();
  for (const groups of Object.values(store.tabGroupsByDirectory)) {
    for (const g of groups) {
      const paneIds = collectPaneIds(g.layout);
      const name = store.tabGroupName(paneIds[0] ?? "");
      for (const pid of paneIds) paneToGroup.set(pid, { id: g.id, name });
    }
  }
  for (const p of procs) {
    const grp = paneToGroup.get(p.tabId!);
    const key = grp?.id ?? p.tabId!;
    let entry = map.get(key);
    if (!entry) {
      entry = { key, name: grp?.name ?? store.tabGroupName(p.tabId!), ram: 0, cpu: 0, panes: [] };
      map.set(key, entry);
      order.push(key);
    }
    entry.ram += p.ram;
    entry.cpu += p.cpu;
    entry.panes.push({ label: paneProcLabel(p), ram: p.ram, cpu: p.cpu });
  }
  return order.map((k) => map.get(k)!);
});

// Process rows we can predict from the store alone (no backend latency), used to
// render placeholders at full height so the popover doesn't resize on first open.
const CORE_PROCESS_PLACEHOLDERS = 3; // App, Daemon, Sidecar
const expectedTabGroups = computed(() =>
  Object.values(store.tabGroupsByDirectory).flatMap((groups) =>
    groups.map((g) => {
      const paneIds = collectPaneIds(g.layout);
      return { key: g.id, name: store.tabGroupName(paneIds[0] ?? ""), paneCount: paneIds.length };
    }),
  ),
);

// Debug rows flattened so the template can skeleton each value uniformly.
const debugRows = computed<{ label: string; value: number | null }[]>(() => {
  const m = debugMetrics.value;
  return [
    { label: "Active Sessions", value: m?.activeSessions ?? null },
    { label: "Git Watchers", value: m?.gitWatchers ?? null },
    { label: "File Indexes", value: m?.cachedFileIndexes ?? null },
    { label: "Cached Paths", value: m?.cachedFilePaths ?? null },
    { label: "Terminals Cached", value: m ? cachedTerminals.value : null },
    { label: "Terminals Attached", value: m ? attachedTerminals.value : null },
    { label: "Terminal Views", value: m ? mountedTerminalViews.value : null },
    { label: "Resize Observers", value: m ? terminalResizeObservers.value : null },
  ];
});

let timer: ReturnType<typeof setInterval> | undefined;

async function poll() {
  const rpc = useRpc();
  // One call: headline totals + per-process rows share a single sample, so the
  // RAM/CPU shown up top always equal the sum of the breakdown below.
  try {
    debugMetrics.value = await rpc.request.getDebugMetrics({});
    usage.value = debugMetrics.value.usage;
  } catch {
    debugMetrics.value = null;
  }
  if (isDev) {
    cachedTerminals.value = getCachedTerminalCount();
    attachedTerminals.value = getAttachedTerminalCount();
    mountedTerminalViews.value = getMountedTerminalViewCount();
    terminalResizeObservers.value = getTerminalResizeObserverCount();
  }
  webglContexts.value = getWebGLContextCount();
}

function fmtCpu(n: number): string {
  return n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

function fmtRam(mb: number): string {
  if (mb >= 1000) return (mb / 1024).toFixed(1) + "GB";
  return mb < 10 ? mb.toFixed(1) + "MB" : Math.round(mb) + "MB";
}

function onOpenChange(open: boolean) {
  if (open) {
    poll();
    timer = setInterval(poll, 2000);
  } else {
    clearInterval(timer);
    timer = undefined;
  }
}

onUnmounted(() => {
  clearInterval(timer);
});
</script>

<template>
  <Popover @update:open="onOpenChange">
    <PopoverTrigger as-child>
      <Button
        size="icon-xs"
        class="text-muted-foreground"
        variant="ghost"
      >
        <Cpu class="size-3.5" />
      </Button>
    </PopoverTrigger>
    <PopoverContent
      side="bottom"
      align="start"
      class="max-h-[70vh] w-72 overflow-y-auto p-3"
    >
      <div class="text-xs font-medium mb-3">Resource Usage</div>
      <div class="flex flex-col gap-1.5 text-xs">
        <div class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground flex items-center gap-1">
            <Cpu class="size-3" />CPU
          </span>
          <span v-if="usage" class="tabular-nums">{{ fmtCpu(usage.cpu) }}%</span>
          <span v-else class="block h-3 w-10 animate-pulse rounded bg-muted-foreground/20" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground flex items-center gap-1">
            <MemoryStick class="size-3" />RAM
          </span>
          <span v-if="usage" class="tabular-nums">{{ fmtRam(usage.ram) }}</span>
          <span v-else class="block h-3 w-10 animate-pulse rounded bg-muted-foreground/20" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground flex items-center gap-1">
            <Bot class="size-3" />Agents
          </span>
          <span v-if="usage" class="tabular-nums">{{ usage.agentCount }}</span>
          <span v-else class="block h-3 w-6 animate-pulse rounded bg-muted-foreground/20" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground flex items-center gap-1">
            <SquareTerminal class="size-3" />Tabs
          </span>
          <span class="tabular-nums">{{ tabCount }}</span>
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground flex items-center gap-1">
            <Blocks class="size-3" />LSPs
          </span>
          <span v-if="usage" class="tabular-nums">{{ usage.lspCount }}</span>
          <span v-else class="block h-3 w-6 animate-pulse rounded bg-muted-foreground/20" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground flex items-center gap-1">
            <FileText class="size-3" />Editors
          </span>
          <span class="tabular-nums">{{ editorTabCount }}</span>
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground flex items-center gap-1">
            <Monitor class="size-3" />WebGL
          </span>
          <span class="tabular-nums">{{ webglContexts }}</span>
        </div>
        <template v-if="isDev">
          <div class="my-1 border-t border-border pt-2 text-[11px] font-medium text-muted-foreground">
            Debug
          </div>
          <div
            v-for="row in debugRows"
            :key="row.label"
            class="flex items-center justify-between gap-2"
          >
            <span class="text-muted-foreground">{{ row.label }}</span>
            <span v-if="row.value !== null" class="tabular-nums">{{ row.value }}</span>
            <span v-else class="block h-3 w-8 animate-pulse rounded bg-muted-foreground/20" />
          </div>
        </template>
        <div class="my-1 border-t border-border pt-2 text-[11px] font-medium text-muted-foreground">
          Processes
        </div>
        <!-- Real metrics once loaded. -->
        <template v-if="debugMetrics">
          <div
            v-for="proc in coreProcesses"
            :key="proc.name"
            class="flex items-center justify-between gap-2"
          >
            <span class="min-w-0 truncate text-muted-foreground">{{ proc.name }}</span>
            <span class="shrink-0 whitespace-nowrap tabular-nums">{{ fmtRam(proc.ram) }} · {{ fmtCpu(proc.cpu) }}%</span>
          </div>
          <!-- One entry per tab; multi-pane tabs list their panes indented. -->
          <template v-for="g in tabProcessGroups" :key="g.key">
            <div class="flex items-center justify-between gap-2">
              <span class="flex min-w-0 items-center gap-1 text-muted-foreground">
                <SquareTerminal class="size-3 shrink-0" /><span class="truncate">{{ g.name }}</span>
              </span>
              <span class="shrink-0 whitespace-nowrap tabular-nums">{{ fmtRam(g.ram) }} · {{ fmtCpu(g.cpu) }}%</span>
            </div>
            <template v-if="g.panes.length > 1">
              <div
                v-for="(pane, pi) in g.panes"
                :key="pi"
                class="flex items-center justify-between gap-2 pl-4 text-muted-foreground"
              >
                <span class="min-w-0 truncate">{{ pane.label }}</span>
                <span class="shrink-0 whitespace-nowrap tabular-nums">{{ fmtRam(pane.ram) }} · {{ fmtCpu(pane.cpu) }}%</span>
              </div>
            </template>
          </template>
        </template>
        <!-- Store-derived placeholders sized to the eventual rows, so the popover
             opens at full height and doesn't jump when metrics arrive. -->
        <template v-else>
          <div
            v-for="n in CORE_PROCESS_PLACEHOLDERS"
            :key="'core-' + n"
            class="flex items-center justify-between gap-2"
          >
            <span class="block h-3 w-16 animate-pulse rounded bg-muted-foreground/20" />
            <span class="block h-3 w-14 animate-pulse rounded bg-muted-foreground/20" />
          </div>
          <template v-for="g in expectedTabGroups" :key="g.key">
            <div class="flex items-center justify-between gap-2">
              <span class="flex min-w-0 items-center gap-1 text-muted-foreground">
                <SquareTerminal class="size-3 shrink-0" /><span class="truncate">{{ g.name }}</span>
              </span>
              <span class="block h-3 w-14 shrink-0 animate-pulse rounded bg-muted-foreground/20" />
            </div>
            <template v-if="g.paneCount > 1">
              <div
                v-for="pi in g.paneCount"
                :key="'p-' + pi"
                class="flex items-center justify-between gap-2 pl-4"
              >
                <span class="block h-3 w-12 animate-pulse rounded bg-muted-foreground/20" />
                <span class="block h-3 w-14 shrink-0 animate-pulse rounded bg-muted-foreground/20" />
              </div>
            </template>
          </template>
        </template>
      </div>
    </PopoverContent>
  </Popover>
</template>
