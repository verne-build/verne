<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  GitBranch as GitBranchIcon,
  Search,
} from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useDirectorySettings } from "@/composables/useDirectorySettings";
import type { AgentLaunchSelection, GitBranch, WorkingDirectory } from "@/types";
import SessionLaunchControls from "@/components/main/SessionLaunchControls.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const props = defineProps<{ dirId: string }>();
const store = useWorkspaceStore();
const rpc = useRpc();
const checkoutMode = ref<"current" | "worktree">("current");
const branches = ref<GitBranch[]>([]);
const selectedBranch = ref<GitBranch | null>(null);
const branchMenuOpen = ref(false);
const branchQuery = ref("");
const dirtyWarningOpen = ref(false);
const launching = ref(false);
const loadingBranches = ref(false);
interface PickerError {
  title: string;
  message: string;
  retry: () => void;
}

const scopeError = ref<PickerError | null>(null);
const branchError = ref<PickerError | null>(null);
const launchError = ref<PickerError | null>(null);
let mounted = false;
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
const roots = computed(() => store.directories.filter((dir) => !dir.parentDirectoryId));
const directoryId = computed(() => current.value?.id ?? null);
const { settings: directorySettings } = useDirectorySettings(directoryId);
const checkoutModeLabel = computed(() => checkoutMode.value === "current"
  ? "Current Checkout"
  : "Create New Worktree");
const branchLabel = computed(() => checkoutMode.value === "worktree" ? "Create From" : "Branch");
const localBranches = computed(() => branches.value.filter((branch) => !branch.isRemote));
const remoteBranches = computed(() => branches.value.filter((branch) => branch.isRemote));
const normalizedBranchQuery = computed(() => branchQuery.value.trim().toLowerCase());
function matchesBranchQuery(branch: GitBranch): boolean {
  const query = normalizedBranchQuery.value;
  return !query || branch.name.toLowerCase().includes(query) || branch.fullRef.toLowerCase().includes(query);
}
const filteredLocalBranches = computed(() => localBranches.value.filter(matchesBranchQuery));
const filteredRemoteBranches = computed(() => remoteBranches.value.filter(matchesBranchQuery));
const hasFilteredBranches = computed(() => filteredLocalBranches.value.length > 0 || filteredRemoteBranches.value.length > 0);
const busy = computed(() => launching.value || loadingBranches.value);
const canStart = computed(() => !!current.value && !!selectedBranch.value && !busy.value);
const pickerError = computed(() => launchError.value ?? branchError.value ?? scopeError.value);

function isCurrentInstance(): boolean {
  return mounted
    && store.pendingPicker?.dirId === props.dirId
    && store.selectedDirectoryId === props.dirId;
}

function homePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function selectBranch(value: string): void {
  selectedBranch.value = branches.value.find((branch) => branch.fullRef === value) ?? null;
}

function setBranchMenuOpen(open: boolean): void {
  branchMenuOpen.value = open;
  branchQuery.value = "";
}

function onBranchFilterKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (!branchQuery.value) return;
    event.preventDefault();
    event.stopPropagation();
    branchQuery.value = "";
    return;
  }
  if (["ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab"].includes(event.key)) return;
  event.stopPropagation();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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

function snapshotStart(agentLaunch: AgentLaunchSelection | undefined): StartSnapshot | null {
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
    agentLaunch,
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
      message: errorMessage(error, "Verne couldn't start this session. Try again."),
      retry: () => void continueStart(snapshot),
    };
  } finally {
    if (mounted && snapshot.requestId === startRequestId && store.pendingPicker?.dirId === props.dirId)
      launching.value = false;
  }
}

async function start(agentLaunch: AgentLaunchSelection | undefined): Promise<void> {
  if (launching.value) return;
  const snapshot = snapshotStart(agentLaunch);
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
      retry: () => void start(agentLaunch),
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
onMounted(() => {
  mounted = true;
  void loadCurrentScope();
  void loadBranches();
});

onUnmounted(() => {
  mounted = false;
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
            <Button type="button" variant="ghost" class="min-h-10 px-2 text-xl font-semibold underline decoration-dotted underline-offset-4" :disabled="launching" aria-label="Select Directory">
              {{ current?.name ?? "Workspace" }}
              <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="min-w-64">
            <DropdownMenuItem v-for="root in roots" :key="root.id" :disabled="launching" @select="selectPickerDirectory(root)">
              <span class="min-w-0">
                <span class="block truncate font-medium">{{ root.name }}</span>
                <span class="block truncate text-xs text-muted-foreground">{{ homePath(root.path) }}</span>
              </span>
              <Check :class="['ml-auto size-3.5', root.id === props.dirId ? 'opacity-100' : 'opacity-0']" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </h2>
      <section aria-labelledby="new-session-picker-title" :aria-busy="busy" class="w-full max-w-4xl rounded-xl border bg-card shadow-sm">
        <div class="p-5">
          <SessionLaunchControls
            :busy="launching"
            :disabled="!canStart"
            @start="start"
          />
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
              <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Checkout Mode</DropdownMenuLabel>
              <DropdownMenuItem @select="checkoutMode = 'current'">
                Current Checkout
                <Check :class="['ml-auto size-3.5', checkoutMode === 'current' ? 'opacity-100' : 'opacity-0']" />
              </DropdownMenuItem>
              <DropdownMenuItem @select="checkoutMode = 'worktree'">
                Create New Worktree
                <Check :class="['ml-auto size-3.5', checkoutMode === 'worktree' ? 'opacity-100' : 'opacity-0']" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu :open="branchMenuOpen" @update:open="setBranchMenuOpen">
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="ghost" class="min-h-10 min-w-0 justify-start px-2 sm:justify-end" :disabled="launching || loadingBranches || !branches.length" aria-label="Select Branch">
                <GitBranchIcon aria-hidden="true" class="size-4 text-muted-foreground" />
                <span class="text-muted-foreground">{{ branchLabel }}</span>
                <span class="truncate font-medium">{{ selectedBranch?.name ?? "Loading" }}</span>
                <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-56 p-0">
              <div class="border-b p-2">
                <div class="relative">
                  <Search aria-hidden="true" class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input v-model="branchQuery" placeholder="Filter Branches…" class="h-8 pl-8 text-xs" @keydown="onBranchFilterKeydown" />
                </div>
              </div>
              <div class="max-h-64 overflow-y-auto p-1">
                <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">{{ branchLabel }}</DropdownMenuLabel>
                <DropdownMenuGroup v-if="filteredLocalBranches.length">
                  <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Local</DropdownMenuLabel>
                  <DropdownMenuItem v-for="branch in filteredLocalBranches" :key="branch.fullRef" @select="selectBranch(branch.fullRef)">
                    <GitBranchIcon aria-hidden="true" class="size-4" />
                    <span class="flex-1 truncate">{{ branch.name }}</span>
                    <Check :class="['ml-auto size-3.5', selectedBranch?.fullRef === branch.fullRef ? 'opacity-100' : 'opacity-0']" />
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator v-if="filteredLocalBranches.length && filteredRemoteBranches.length" />
                <DropdownMenuGroup v-if="filteredRemoteBranches.length">
                  <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Remote</DropdownMenuLabel>
                  <DropdownMenuItem v-for="branch in filteredRemoteBranches" :key="branch.fullRef" @select="selectBranch(branch.fullRef)">
                    <Cloud aria-hidden="true" class="size-4" />
                    <span class="flex-1 truncate">{{ branch.name }}</span>
                    <Check :class="['ml-auto size-3.5', selectedBranch?.fullRef === branch.fullRef ? 'opacity-100' : 'opacity-0']" />
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <p v-if="!hasFilteredBranches" class="px-2 py-1.5 text-xs text-muted-foreground">No Branches Found</p>
              </div>
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
