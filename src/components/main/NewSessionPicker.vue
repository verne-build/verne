<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Bot, ChevronDown, CircleAlert, SquareTerminal } from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { useTheme } from "@/composables/useTheme";
import {
  agentIconSurfaceForTheme,
  findAgentIconForSurface,
} from "@/composables/useAgentIcon";
import {
  loadAvailableAgents,
  type AgentDefinition,
} from "@/lib/agentRegistry";
import type { WorkingDirectory } from "@/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
const { getActiveThemeSpec } = useTheme();
const terminalButton = ref<HTMLButtonElement | null>(null);
const agents = ref<AgentDefinition[]>([]);
const busy = ref(false);

type RetryAction =
  | { kind: "launch"; launchCommand?: string; label: string }
  | { kind: "scope"; directory: WorkingDirectory };

interface PickerError {
  title: string;
  message: string;
  retry: RetryAction;
}

const pickerError = ref<PickerError | null>(null);

const current = computed(() => store.directories.find((dir) => dir.id === props.dirId) ?? null);
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
const currentRoot = computed(() => current.value?.parentDirectoryId
  ? store.directories.find((dir) => dir.id === current.value?.parentDirectoryId) ?? null
  : current.value);
const scopeTitle = computed(() => current.value?.parentDirectoryId
  ? `${currentRoot.value?.name ?? "Workspace"} / ${current.value.name}`
  : current.value?.name ?? "Workspace");
const scopePath = computed(() => homePath(current.value?.path ?? ""));
const surface = computed(() => agentIconSurfaceForTheme(getActiveThemeSpec().type));
const agentChoices = computed(() => agents.value.map((agent) => ({
  ...agent,
  icon: findAgentIconForSurface(agent.type, surface.value),
})));
const canDismiss = computed(() => (store.terminalTabsByDirectory[props.dirId] ?? []).length > 0);

function homePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function scopeLabel(dir: WorkingDirectory): string {
  if (!dir.parentDirectoryId) return dir.name;
  const root = store.directories.find((candidate) => candidate.id === dir.parentDirectoryId);
  return `${root?.name ?? "Workspace"} / ${dir.name}`;
}

async function selectScope(dir: WorkingDirectory): Promise<void> {
  if (busy.value || dir.id === props.dirId) return;
  const sourceScope = props.dirId;
  busy.value = true;
  pickerError.value = null;
  try {
    await store.loadTabsForDirectory(dir.id);
    if (store.pendingPicker?.dirId === sourceScope) store.selectDirectory(dir);
  } catch (error) {
    console.error("[NewSessionPicker] scope load failed:", error);
    if (store.pendingPicker?.dirId === sourceScope) {
      pickerError.value = {
        title: "Couldn't Load Scope",
        message: `Verne couldn't load ${scopeLabel(dir)}. Try again.`,
        retry: { kind: "scope", directory: dir },
      };
    }
  } finally {
    busy.value = false;
  }
}

async function launch(launchCommand: string | undefined, label: string): Promise<void> {
  if (busy.value) return;
  const launchedScope = props.dirId;
  busy.value = true;
  pickerError.value = null;
  try {
    await store.newSession(launchedScope, { launchCommand });
    if (store.pendingPicker?.dirId === launchedScope) store.closeSessionPicker();
  } catch (error) {
    console.error("[NewSessionPicker] create failed:", error);
    if (store.pendingPicker?.dirId === launchedScope) {
      pickerError.value = {
        title: "Couldn't Start Session",
        message: `Verne couldn't start ${label}. Try again${launchCommand ? " or start a Terminal instead" : ""}.`,
        retry: { kind: "launch", launchCommand, label },
      };
    }
  } finally {
    busy.value = false;
  }
}

async function retryFailedAction(): Promise<void> {
  const action = pickerError.value?.retry;
  if (!action) return;
  if (action.kind === "scope") await selectScope(action.directory);
  else await launch(action.launchCommand, action.label);
}

function onEscape(): void {
  if (canDismiss.value) store.closeSessionPicker();
}

onMounted(() => {
  terminalButton.value?.focus();
  void loadAvailableAgents((bins) => rpc.request.agentBinsAvailable({ bins }))
    .then((available) => { agents.value = available; })
    .catch((error) => {
      console.warn("[NewSessionPicker] agent availability failed:", error);
      agents.value = [];
    });
});
</script>

<template>
  <div class="flex h-full min-h-0 items-center justify-center p-8" @keydown.esc.stop="onEscape">
    <section
      aria-labelledby="new-session-picker-title"
      :aria-busy="busy"
      class="w-full max-w-2xl rounded-xl border bg-card p-6 shadow-sm"
    >
      <div class="mb-6">
        <h2
          id="new-session-picker-title"
          class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          New Session
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="outline"
              class="min-h-10 w-full justify-between px-3 py-2 text-left"
              :disabled="busy"
            >
              <span class="min-w-0">
                <span class="block truncate font-medium">{{ scopeTitle }}</span>
                <span class="block truncate text-xs font-normal text-muted-foreground">{{ scopePath }}</span>
              </span>
              <ChevronDown aria-hidden="true" class="ml-3 size-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-[var(--reka-dropdown-menu-trigger-width)]" align="start">
            <DropdownMenuLabel>Scopes</DropdownMenuLabel>
            <template v-for="(root, rootIndex) in roots" :key="root.id">
              <DropdownMenuSeparator v-if="rootIndex > 0" />
              <DropdownMenuGroup>
                <DropdownMenuItem :disabled="busy" @select="selectScope(root)">
                  <span class="min-w-0">
                    <span class="block truncate">{{ root.name }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ homePath(root.path) }}</span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-for="worktree in worktreesByRoot.get(root.id) ?? []"
                  :key="worktree.id"
                  class="pl-6"
                  :disabled="busy"
                  @select="selectScope(worktree)"
                >
                  <span class="min-w-0">
                    <span class="block truncate">{{ root.name }} / {{ worktree.name }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ homePath(worktree.path) }}</span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div>
        <p class="mb-3 text-sm font-medium">Start With</p>
        <div class="flex flex-wrap gap-2">
          <Button
            v-for="agent in agentChoices"
            :key="agent.type"
            type="button"
            variant="outline"
            class="h-12 gap-2 px-4"
            :disabled="busy"
            @click="launch(agent.bin, agent.label)"
          >
            <img v-if="agent.icon" :src="agent.icon" alt="" class="size-5" />
            <Bot v-else aria-hidden="true" class="size-5" />
            <span>{{ agent.label }}</span>
          </Button>
          <Button
            ref="terminalButton"
            type="button"
            variant="outline"
            class="h-12 gap-2 px-4"
            :disabled="busy"
            @click="launch(undefined, 'Terminal')"
          >
            <SquareTerminal aria-hidden="true" class="size-5" />
            <span>Terminal</span>
          </Button>
        </div>

        <Alert v-if="pickerError" variant="destructive" class="mt-4" aria-atomic="true">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{{ pickerError.title }}</AlertTitle>
          <AlertDescription class="flex w-full items-center gap-3">
            <span class="flex-1 text-pretty">{{ pickerError.message }}</span>
            <Button
              type="button"
              variant="outline"
              class="h-10 shrink-0"
              :disabled="busy"
              @click="retryFailedAction"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    </section>
  </div>
</template>
