<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { AcceptableValue } from "reka-ui";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  Gauge,
  GitBranch as GitBranchIcon,
  Rocket,
  SquareTerminal,
  Zap,
} from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useTheme } from "@/composables/useTheme";
import { useDirectorySettings } from "@/composables/useDirectorySettings";
import {
  agentIconSurfaceForTheme,
  findAgentIconForSurface,
} from "@/composables/useAgentIcon";
import {
  loadAvailableAgents,
  type AgentDefinition,
  type ModelDefinition,
} from "@/lib/agentRegistry";
import type { AgentLaunchSelection, AgentType, GitBranch, WorkingDirectory } from "@/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const props = defineProps<{ dirId: string }>();
const store = useWorkspaceStore();
const rpc = useRpc();
const { getActiveThemeSpec } = useTheme();

const startButton = ref<{ $el?: HTMLElement } | null>(null);
const agents = ref<AgentDefinition[]>([]);
const selectedAgentType = ref<AgentType | "terminal" | null>(null);
const agentSelectionTouched = ref(false);
const selectedModelId = ref<string | null>(null);
const selectedEffort = ref<string | null>(null);
const fast = ref(false);
const checkoutMode = ref<"current" | "worktree">("current");
const branches = ref<GitBranch[]>([]);
const selectedBranch = ref<GitBranch | null>(null);
const dirtyWarningOpen = ref(false);
const launching = ref(false);
const loadingBranches = ref(false);
const agentLoading = ref(false);
interface PickerError {
  title: string;
  message: string;
  retry: () => void;
}

const scopeError = ref<PickerError | null>(null);
const agentError = ref<PickerError | null>(null);
const branchError = ref<PickerError | null>(null);
const launchError = ref<PickerError | null>(null);
let mounted = false;
let agentRequestId = 0;
let branchRequestId = 0;
let startRequestId = 0;

interface StartSnapshot {
  requestId: number;
  branchRequestId: number;
  directoryId: string;
  path: string;
  mode: "current" | "worktree";
  branch: GitBranch;
  agentLaunch?: AgentLaunchSelection;
}

const pendingStart = ref<StartSnapshot | null>(null);
const current = computed<WorkingDirectory | null>(() =>
  store.directories.find((dir) => dir.id === props.dirId) ?? null,
);
const roots = computed(() => {
  const ids = new Set(store.directories.map((dir) => dir.id));
  return store.directories.filter((dir) => !dir.parentDirectoryId || !ids.has(dir.parentDirectoryId));
});
const worktreesByRoot = computed(() => {
  const groups = new Map<string, WorkingDirectory[]>();
  for (const dir of store.directories) {
    if (!dir.parentDirectoryId) continue;
    const children = groups.get(dir.parentDirectoryId) ?? [];
    children.push(dir);
    groups.set(dir.parentDirectoryId, children);
  }
  return groups;
});
const directoryId = computed(() => current.value?.id ?? null);
const { settings: directorySettings } = useDirectorySettings(directoryId);
const surface = computed(() => agentIconSurfaceForTheme(getActiveThemeSpec().type));
const agentChoices = computed(() => agents.value.map((agent) => ({
  ...agent,
  icon: findAgentIconForSurface(agent.type, surface.value),
})));
const selectedAgent = computed(() => selectedAgentType.value && selectedAgentType.value !== "terminal"
  ? agents.value.find((agent) => agent.type === selectedAgentType.value) ?? null
  : null,
);
const selectedModel = computed<ModelDefinition | null>(() => selectedModelId.value
  ? selectedAgent.value?.models.find((model) => model.id === selectedModelId.value) ?? null
  : null,
);
const isTerminal = computed(() => !selectedAgent.value);
function effortsFor(model: ModelDefinition | null): string[] {
  if (!model) return [];
  if (model.efforts) return [...model.efforts];
  return [...new Set(Object.keys(model.cursorVariants ?? {})
    .map((variant) => variant.split(":")[0]!)
    .filter((effort) => effort !== "default"))];
}
function supportsFastFor(model: ModelDefinition | null): boolean {
  return !!model?.fast || Object.keys(model?.cursorVariants ?? {}).some((variant) => variant.endsWith(":on"));
}
const availableEfforts = computed(() => effortsFor(selectedModel.value));
const supportsFast = computed(() => supportsFastFor(selectedModel.value));
const showTuning = computed(() => availableEfforts.value.length > 0 || supportsFast.value);
const selectedAgentLabel = computed(() => selectedAgent.value?.label ?? "Terminal");
const selectedModelLabel = computed(() => selectedModel.value?.label ?? "Model Default");
const tuningLabel = computed(() => {
  const labels: string[] = [];
  if (isTerminal.value || availableEfforts.value.length)
    labels.push(selectedEffort.value
      ? `Effort ${selectedEffort.value[0]!.toUpperCase()}${selectedEffort.value.slice(1)}`
      : "Effort Default");
  if (supportsFast.value) labels.push(`Fast Mode ${fast.value ? "On" : "Off"}`);
  return labels.join(" · ");
});
const checkoutModeLabel = computed(() => checkoutMode.value === "current"
  ? "Current Checkout"
  : "Create New Worktree");
const branchLabel = computed(() => checkoutMode.value === "worktree" ? "Create From" : "Branch");
const localBranches = computed(() => branches.value.filter((branch) => !branch.isRemote));
const remoteBranches = computed(() => branches.value.filter((branch) => branch.isRemote));
const busy = computed(() => launching.value || loadingBranches.value);
const canStart = computed(() => !!current.value && !!selectedBranch.value && !busy.value);
const pickerError = computed(() => launchError.value ?? branchError.value ?? agentError.value ?? scopeError.value);

function isCurrentInstance(): boolean {
  return mounted
    && store.pendingPicker?.dirId === props.dirId
    && store.selectedDirectoryId === props.dirId;
}

function homePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function compatibleModel(): void {
  if (!selectedModel.value) {
    selectedEffort.value = null;
    fast.value = false;
    return;
  }
  if (selectedEffort.value && !availableEfforts.value.includes(selectedEffort.value))
    selectedEffort.value = null;
  if (!supportsFast.value) fast.value = false;
}

function selectAgent(value: AcceptableValue): void {
  if (typeof value !== "string") return;
  agentSelectionTouched.value = true;
  selectedAgentType.value = value === "terminal" ? "terminal" : value as AgentType;
  selectedModelId.value = null;
  selectedEffort.value = null;
  fast.value = false;
}

function selectModel(value: AcceptableValue): void {
  if (typeof value !== "string") return;
  selectedModelId.value = value === "default" ? null : value;
  const nextModel = selectedModelId.value
    ? selectedAgent.value?.models.find((model) => model.id === selectedModelId.value) ?? null
    : null;
  if (selectedEffort.value && !effortsFor(nextModel).includes(selectedEffort.value))
    selectedEffort.value = null;
  if (!supportsFastFor(nextModel)) fast.value = false;
}

function selectEffort(value: AcceptableValue): void {
  if (typeof value !== "string") return;
  selectedEffort.value = value === "default" ? null : value;
}

function selectFast(value: AcceptableValue): void {
  if (typeof value !== "string") return;
  fast.value = value === "on";
}

function selectBranch(value: AcceptableValue): void {
  if (typeof value !== "string") return;
  selectedBranch.value = branches.value.find((branch) => branch.fullRef === value) ?? null;
}

function selectPickerDirectory(directory: WorkingDirectory): void {
  if (launching.value) return;
  const target = store.directories.find((candidate) => candidate.id === directory.id);
  if (!target) return;
  store.selectDirectory(target);
  store.openSessionPicker(target.id);
}

function preferredBranch(nextBranches: GitBranch[]): GitBranch | null {
  if (checkoutMode.value === "current") return nextBranches.find((branch) => branch.isHead) ?? null;
  const preferred = [
    directorySettings.value.defaultBaseRef,
    "main",
    "origin/main",
    "master",
    "origin/master",
  ].filter((ref): ref is string => !!ref);
  return preferred.map((ref) => nextBranches.find((branch) => branch.name === ref || branch.fullRef === ref))
    .find((branch): branch is GitBranch => !!branch)
    ?? nextBranches.find((branch) => branch.isHead)
    ?? null;
}

async function loadCurrentScope(): Promise<void> {
  const dir = current.value;
  if (!dir || !isCurrentInstance()) return;
  try {
    await store.loadTabsForDirectory(dir.id);
    if (isCurrentInstance()) scopeError.value = null;
  } catch (error) {
    if (!isCurrentInstance()) return;
    console.error("[NewSessionPicker] scope load failed:", error);
    scopeError.value = {
      title: "Couldn't Load Scope",
      message: `Verne couldn't load ${dir.name}. Try again.`,
      retry: () => void loadCurrentScope(),
    };
  }
}

async function loadAgentChoices(): Promise<void> {
  const requestId = ++agentRequestId;
  agentLoading.value = true;
  try {
    const available = await loadAvailableAgents((bins) => rpc.request.agentBinsAvailable({ bins }));
    if (!isCurrentInstance() || requestId !== agentRequestId) return;
    agents.value = available;
    if (!agentSelectionTouched.value)
      selectedAgentType.value = available[0]?.type ?? "terminal";
    agentError.value = null;
  } catch (error) {
    if (!isCurrentInstance() || requestId !== agentRequestId) return;
    console.warn("[NewSessionPicker] agent availability failed:", error);
    agents.value = [];
    if (!agentSelectionTouched.value) selectedAgentType.value = "terminal";
    agentError.value = {
      title: "Couldn't Load Agents",
      message: "Verne couldn't check installed agents. Terminal is still available.",
      retry: () => void loadAgentChoices(),
    };
  } finally {
    if (isCurrentInstance() && requestId === agentRequestId) agentLoading.value = false;
  }
}

async function loadBranches(): Promise<void> {
  const dir = current.value;
  if (!dir || !isCurrentInstance()) return;
  const requestId = ++branchRequestId;
  const path = dir.path;
  const mode = checkoutMode.value;
  loadingBranches.value = true;
  try {
    const nextBranches = await rpc.request.gitListBranches({ path });
    if (!isCurrentInstance() || requestId !== branchRequestId || path !== current.value?.path || mode !== checkoutMode.value)
      return;
    branches.value = nextBranches;
    selectedBranch.value = preferredBranch(nextBranches);
    branchError.value = null;
  } catch (error) {
    if (!isCurrentInstance() || requestId !== branchRequestId || path !== current.value?.path || mode !== checkoutMode.value)
      return;
    console.error("[NewSessionPicker] branch load failed:", error);
    branches.value = [];
    selectedBranch.value = null;
    branchError.value = {
      title: "Couldn't Load Branches",
      message: "Verne couldn't load branches for this workspace. Try again.",
      retry: () => void loadBranches(),
    };
  } finally {
    if (isCurrentInstance() && requestId === branchRequestId && path === current.value?.path && mode === checkoutMode.value)
      loadingBranches.value = false;
  }
}

function launchSelection(): AgentLaunchSelection | undefined {
  if (!selectedAgent.value) return undefined;
  return {
    agentType: selectedAgent.value.type,
    modelId: selectedModelId.value,
    effort: selectedEffort.value,
    fast: supportsFast.value ? fast.value : null,
  };
}

function snapshotStart(): StartSnapshot | null {
  const dir = current.value;
  const branch = selectedBranch.value;
  if (!dir || !branch) return null;
  return {
    requestId: ++startRequestId,
    branchRequestId,
    directoryId: dir.id,
    path: dir.path,
    mode: checkoutMode.value,
    branch,
    agentLaunch: launchSelection(),
  };
}

async function continueStart(snapshot: StartSnapshot): Promise<void> {
  if (!isCurrentInstance() || snapshot.requestId !== startRequestId) return;
  launching.value = true;
  launchError.value = null;
  try {
    await store.startPickerSession({
      directoryId: snapshot.directoryId,
      mode: snapshot.mode,
      branch: snapshot.branch,
      agentLaunch: snapshot.agentLaunch,
    });
    if (mounted && snapshot.requestId === startRequestId && store.pendingPicker?.dirId === props.dirId)
      store.closeSessionPicker();
  } catch (error) {
    if (!isCurrentInstance() || snapshot.requestId !== startRequestId) return;
    console.error("[NewSessionPicker] create failed:", error);
    launchError.value = {
      title: "Couldn't Start Session",
      message: "Verne couldn't start this session. Try again.",
      retry: () => void continueStart(snapshot),
    };
  } finally {
    if (mounted && snapshot.requestId === startRequestId && store.pendingPicker?.dirId === props.dirId)
      launching.value = false;
  }
}

async function start(): Promise<void> {
  if (launching.value) return;
  const snapshot = snapshotStart();
  if (!snapshot) return;
  if (snapshot.mode === "worktree" || snapshot.branch.isHead) {
    await continueStart(snapshot);
    return;
  }
  launching.value = true;
  launchError.value = null;
  try {
    const status = await rpc.request.gitStatus({ path: snapshot.path });
    if (!isCurrentInstance() || snapshot.requestId !== startRequestId || snapshot.branchRequestId !== branchRequestId)
      return;
    if (status.staged.length || status.unstaged.length || status.untracked.length) {
      pendingStart.value = snapshot;
      dirtyWarningOpen.value = true;
      return;
    }
    await continueStart(snapshot);
  } catch (error) {
    if (!isCurrentInstance() || snapshot.requestId !== startRequestId) return;
    console.error("[NewSessionPicker] status failed:", error);
    launchError.value = {
      title: "Couldn't Check Changes",
      message: "Verne couldn't check local changes. Try again.",
      retry: () => void start(),
    };
  } finally {
    if (isCurrentInstance() && snapshot.requestId === startRequestId) launching.value = false;
  }
}

function confirmDirtyStart(): void {
  const snapshot = pendingStart.value;
  pendingStart.value = null;
  dirtyWarningOpen.value = false;
  if (snapshot) void continueStart(snapshot);
}

function onEscape(): void {
  if ((store.terminalTabsByDirectory[props.dirId] ?? []).length > 0) store.closeSessionPicker();
}

watch([() => current.value?.id, checkoutMode], () => {
  void loadBranches();
});
watch(() => directorySettings.value.defaultBaseRef, () => {
  if (checkoutMode.value === "worktree") void loadBranches();
});
watch([selectedAgent, selectedModel], compatibleModel);

onMounted(() => {
  mounted = true;
  void loadCurrentScope();
  void loadAgentChoices();
  void loadBranches();
  void nextTick(() => startButton.value?.$el?.focus?.());
});

onUnmounted(() => {
  mounted = false;
  agentRequestId++;
  branchRequestId++;
  startRequestId++;
});
</script>

<template>
  <div class="flex h-full min-h-0 items-center justify-center p-5 sm:p-8" @keydown.esc.stop="onEscape">
    <div class="w-full max-w-4xl">
      <h2 id="new-session-picker-title" class="mb-3 flex flex-wrap items-center gap-1 text-xl font-semibold tracking-tight text-foreground">
        <span>Start New Session In</span>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button type="button" variant="ghost" class="min-h-10 px-2 text-xl font-semibold" :disabled="launching" aria-label="Select Directory">
              {{ current?.name ?? "Workspace" }}
              <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="min-w-64">
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            <template v-for="(root, rootIndex) in roots" :key="root.id">
              <DropdownMenuSeparator v-if="rootIndex > 0" />
              <DropdownMenuGroup>
                <DropdownMenuItem class="min-h-10" :disabled="launching" @select="selectPickerDirectory(root)">
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ root.name }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ homePath(root.path) }}</span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-for="worktree in worktreesByRoot.get(root.id) ?? []"
                  :key="worktree.id"
                  class="min-h-10 pl-6"
                  :disabled="launching"
                  @select="selectPickerDirectory(worktree)"
                >
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ root.name }} / {{ worktree.name }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ homePath(worktree.path) }}</span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </h2>
      <section aria-labelledby="new-session-picker-title" :aria-busy="busy" class="w-full max-w-4xl rounded-xl border bg-card shadow-sm">
        <div class="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="outline" class="min-h-10 w-full justify-between px-3" :disabled="launching" aria-label="Select Agent">
                <span class="flex min-w-0 items-center gap-2">
                  <img v-if="selectedAgent && findAgentIconForSurface(selectedAgent.type, surface)" :src="findAgentIconForSurface(selectedAgent.type, surface)" alt="" class="size-4" />
                  <SquareTerminal v-else-if="isTerminal" aria-hidden="true" class="size-4 text-muted-foreground" />
                  <Bot v-else aria-hidden="true" class="size-4 text-muted-foreground" />
                  <span class="truncate">{{ selectedAgentLabel }}</span>
                </span>
                <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-[var(--reka-dropdown-menu-trigger-width)]">
              <DropdownMenuLabel>Agents</DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="selectedAgentType ?? 'terminal'" @update:model-value="selectAgent">
                <DropdownMenuRadioItem v-for="agent in agentChoices" :key="agent.type" :value="agent.type" class="min-h-10">
                  <img v-if="agent.icon" :src="agent.icon" alt="" class="size-4" />
                  <Bot v-else aria-hidden="true" class="size-4 text-muted-foreground" />
                  {{ agent.label }}
                </DropdownMenuRadioItem>
                <DropdownMenuSeparator v-if="agentChoices.length" />
                <DropdownMenuRadioItem value="terminal" class="min-h-10">
                  <SquareTerminal aria-hidden="true" class="size-4 text-muted-foreground" />
                  Terminal
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="outline" class="min-h-10 w-full justify-between px-3" :disabled="isTerminal || launching" aria-label="Select Model">
                <span class="truncate">{{ selectedModelLabel }}</span>
                <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-[var(--reka-dropdown-menu-trigger-width)]">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="selectedModelId ?? 'default'" @update:model-value="selectModel">
                <DropdownMenuRadioItem value="default" class="min-h-10">Default</DropdownMenuRadioItem>
                <DropdownMenuRadioItem v-for="model in selectedAgent?.models ?? []" :key="model.id" :value="model.id" class="min-h-10">
                  {{ model.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu v-if="showTuning || isTerminal">
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="outline" class="min-h-10 w-full justify-between px-3" :disabled="isTerminal || launching" aria-label="Select Effort Or Fast Mode">
                <span class="truncate">{{ tuningLabel }}</span>
                <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-[var(--reka-dropdown-menu-trigger-width)]">
              <template v-if="availableEfforts.length">
                <DropdownMenuLabel>Effort</DropdownMenuLabel>
                <DropdownMenuRadioGroup :model-value="selectedEffort ?? 'default'" @update:model-value="selectEffort">
                  <DropdownMenuRadioItem value="default" class="min-h-10">Default</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem v-for="effort in availableEfforts" :key="effort" :value="effort" class="min-h-10">
                    {{ effort[0]?.toUpperCase() }}{{ effort.slice(1) }}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </template>
              <DropdownMenuSeparator v-if="availableEfforts.length && supportsFast" />
              <template v-if="supportsFast">
                <DropdownMenuLabel>Fast Mode</DropdownMenuLabel>
                <DropdownMenuRadioGroup :model-value="fast ? 'on' : 'off'" @update:model-value="selectFast">
                  <DropdownMenuRadioItem value="on" class="min-h-10"><Zap aria-hidden="true" class="size-4" />On</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="off" class="min-h-10">Off</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>
          <div v-else class="hidden sm:block" aria-hidden="true" />

          <Button ref="startButton" type="button" class="min-h-10 px-5 active:scale-[0.96] transition-transform" :disabled="!canStart" @click="start">
            <Rocket aria-hidden="true" class="size-4" />
            {{ launching ? "Starting" : "Start" }}
          </Button>
        </div>

        <div class="flex flex-col gap-2 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="ghost" class="min-h-10 justify-start px-2" :disabled="launching" aria-label="Select Checkout Mode">
                <GitBranchIcon aria-hidden="true" class="size-4 text-muted-foreground" />
                {{ checkoutModeLabel }}
                <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Checkout Mode</DropdownMenuLabel>
              <DropdownMenuRadioGroup v-model="checkoutMode">
                <DropdownMenuRadioItem value="current" class="min-h-10">Current Checkout</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="worktree" class="min-h-10">Create New Worktree</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="ghost" class="min-h-10 min-w-0 justify-start px-2 sm:justify-end" :disabled="launching || loadingBranches || !branches.length" aria-label="Select Branch">
                <Gauge aria-hidden="true" class="size-4 text-muted-foreground" />
                <span class="text-muted-foreground">{{ branchLabel }}</span>
                <span class="truncate font-medium">{{ selectedBranch?.name ?? "Loading" }}</span>
                <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-56">
              <DropdownMenuLabel>{{ branchLabel }}</DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="selectedBranch?.fullRef" @update:model-value="selectBranch">
                <DropdownMenuGroup v-if="localBranches.length">
                  <DropdownMenuLabel>Local</DropdownMenuLabel>
                  <DropdownMenuRadioItem v-for="branch in localBranches" :key="branch.fullRef" :value="branch.fullRef" class="min-h-10">
                    <GitBranchIcon aria-hidden="true" class="size-4" />
                    <span class="flex-1 truncate">{{ branch.name }}</span>
                    <Check v-if="branch.isHead" aria-label="Current Branch" class="size-4 text-muted-foreground" />
                  </DropdownMenuRadioItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator v-if="localBranches.length && remoteBranches.length" />
                <DropdownMenuGroup v-if="remoteBranches.length">
                  <DropdownMenuLabel>Remote</DropdownMenuLabel>
                  <DropdownMenuRadioItem v-for="branch in remoteBranches" :key="branch.fullRef" :value="branch.fullRef" class="min-h-10">
                    <Cloud aria-hidden="true" class="size-4" />
                    <span class="truncate">{{ branch.name }}</span>
                  </DropdownMenuRadioItem>
                </DropdownMenuGroup>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div v-if="pickerError" class="border-t p-5">
          <Alert variant="destructive" aria-atomic="true">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{{ pickerError.title }}</AlertTitle>
            <AlertDescription class="flex items-center justify-between gap-3 text-pretty">
              <span>{{ pickerError.message }}</span>
              <Button type="button" variant="outline" class="min-h-10 shrink-0" :disabled="busy" @click="pickerError.retry">Retry</Button>
            </AlertDescription>
          </Alert>
        </div>
      </section>
      <p class="mt-3 truncate text-xs text-muted-foreground">{{ homePath(current?.path ?? "") }}</p>
    </div>
  </div>

  <AlertDialog :open="dirtyWarningOpen" @update:open="dirtyWarningOpen = $event">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Switch To {{ pendingStart?.branch.name }}?</AlertDialogTitle>
        <AlertDialogDescription>
          Local changes will remain in this working tree while Verne switches to the selected branch.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel class="min-h-10">Cancel</AlertDialogCancel>
        <AlertDialogAction class="min-h-10" @click="confirmDirtyStart">Switch And Start</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
