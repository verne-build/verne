<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Bot, ChevronDown, SquareTerminal } from "@lucide/vue";
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

function selectScope(dir: WorkingDirectory): void {
  store.selectDirectory(dir);
  void store.loadTabsForDirectory(dir.id);
}

async function launch(launchCommand?: string): Promise<void> {
  try {
    await store.newSession(props.dirId, { launchCommand });
    store.closeSessionPicker();
  } catch (error) {
    console.error("[NewSessionPicker] create failed:", error);
  }
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
    <section class="w-full max-w-2xl rounded-xl border bg-card p-6 shadow-sm">
      <div class="mb-6">
        <p class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">New Session</p>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" class="h-auto w-full justify-between px-3 py-2 text-left">
              <span class="min-w-0">
                <span class="block truncate font-medium">{{ scopeTitle }}</span>
                <span class="block truncate text-xs font-normal text-muted-foreground">{{ scopePath }}</span>
              </span>
              <ChevronDown class="ml-3 size-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-[var(--reka-dropdown-menu-trigger-width)]" align="start">
            <DropdownMenuLabel>Scopes</DropdownMenuLabel>
            <template v-for="(root, rootIndex) in roots" :key="root.id">
              <DropdownMenuSeparator v-if="rootIndex > 0" />
              <DropdownMenuGroup>
                <DropdownMenuItem @select="selectScope(root)">
                  <span class="min-w-0">
                    <span class="block truncate">{{ root.name }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ homePath(root.path) }}</span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-for="worktree in worktreesByRoot.get(root.id) ?? []"
                  :key="worktree.id"
                  class="pl-6"
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
            @click="launch(agent.bin)"
          >
            <img v-if="agent.icon" :src="agent.icon" :alt="`${agent.label} icon`" class="size-5" />
            <Bot v-else class="size-5" />
            <span>{{ agent.label }}</span>
          </Button>
          <Button
            ref="terminalButton"
            type="button"
            variant="outline"
            class="h-12 gap-2 px-4"
            @click="launch()"
          >
            <SquareTerminal class="size-5" />
            <span>Terminal</span>
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>
