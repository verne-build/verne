<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowRight, Bot, Check, ChevronDown, CircleAlert, SquareTerminal, Zap } from "@lucide/vue";
import { useRpc } from "@/composables/useRpc";
import { useTheme } from "@/composables/useTheme";
import { agentIconSurfaceForTheme, findAgentIconForSurface } from "@/composables/useAgentIcon";
import { loadAvailableAgents, type AgentDefinition, type ModelDefinition } from "@/lib/agentRegistry";
import type { AgentLaunchSelection, AgentType } from "@/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const props = withDefaults(defineProps<{ busy?: boolean; compact?: boolean; disabled?: boolean }>(), {
  busy: false,
  compact: false,
  disabled: false,
});
const emit = defineEmits<{ start: [selection: AgentLaunchSelection | undefined] }>();
const rpc = useRpc();
const { getActiveThemeSpec } = useTheme();

const agents = ref<AgentDefinition[]>([]);
const selectedAgentType = ref<AgentType | "terminal" | null>(null);
const agentSelectionTouched = ref(false);
const selectedModelId = ref<string | null>(null);
const selectedEffort = ref<string | null>(null);
const fast = ref(false);
const loading = ref(false);
const error = ref(false);
let mounted = false;
let requestId = 0;

const surface = computed(() => agentIconSurfaceForTheme(getActiveThemeSpec().type));
const agentChoices = computed(() => agents.value.map((agent) => ({
  ...agent,
  icon: findAgentIconForSurface(agent.type, surface.value),
})));
const selectedAgent = computed(() => selectedAgentType.value && selectedAgentType.value !== "terminal"
  ? agents.value.find((agent) => agent.type === selectedAgentType.value) ?? null
  : null);
const selectedModel = computed<ModelDefinition | null>(() => selectedModelId.value
  ? selectedAgent.value?.models.find((model) => model.id === selectedModelId.value) ?? null
  : null);
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

function selectAgent(value: AgentType | "terminal"): void {
  agentSelectionTouched.value = true;
  selectedAgentType.value = value;
  selectedModelId.value = null;
  selectedEffort.value = null;
  fast.value = false;
}

function selectModel(value: string): void {
  selectedModelId.value = value === "default" ? null : value;
  const nextModel = selectedModelId.value
    ? selectedAgent.value?.models.find((model) => model.id === selectedModelId.value) ?? null
    : null;
  if (selectedEffort.value && !effortsFor(nextModel).includes(selectedEffort.value))
    selectedEffort.value = null;
  if (!supportsFastFor(nextModel)) fast.value = false;
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

async function loadAgentChoices(): Promise<void> {
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const available = await loadAvailableAgents((bins) => rpc.request.agentBinsAvailable({ bins }));
    if (!mounted || currentRequest !== requestId) return;
    agents.value = available;
    if (!agentSelectionTouched.value) selectedAgentType.value = available[0]?.type ?? "terminal";
    error.value = false;
  } catch {
    if (!mounted || currentRequest !== requestId) return;
    agents.value = [];
    if (!agentSelectionTouched.value) selectedAgentType.value = "terminal";
    error.value = true;
  } finally {
    if (mounted && currentRequest === requestId) loading.value = false;
  }
}

watch([selectedAgent, selectedModel], compatibleModel);
onMounted(() => {
  mounted = true;
  void loadAgentChoices();
});
onUnmounted(() => {
  mounted = false;
  requestId += 1;
});
</script>

<template>
  <div :class="['grid gap-3', compact ? 'grid-cols-1' : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]']" :aria-busy="loading || busy">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button type="button" variant="outline" class="min-h-10 w-full justify-between px-3" :disabled="busy" aria-label="Select Agent">
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
        <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Agents</DropdownMenuLabel>
        <DropdownMenuItem v-for="agent in agentChoices" :key="agent.type" @select="selectAgent(agent.type)">
          <img v-if="agent.icon" :src="agent.icon" alt="" class="size-4" />
          <Bot v-else aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ agent.label }}
          <Check :class="['ml-auto size-3.5', selectedAgentType === agent.type ? 'opacity-100' : 'opacity-0']" />
        </DropdownMenuItem>
        <DropdownMenuSeparator v-if="agentChoices.length" />
        <DropdownMenuItem @select="selectAgent('terminal')">
          <SquareTerminal aria-hidden="true" class="size-4 text-muted-foreground" />
          Terminal
          <Check :class="['ml-auto size-3.5', isTerminal ? 'opacity-100' : 'opacity-0']" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button type="button" variant="outline" class="min-h-10 w-full justify-between px-3" :disabled="isTerminal || busy" aria-label="Select Model">
          <span class="truncate">{{ selectedModelLabel }}</span>
          <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-[var(--reka-dropdown-menu-trigger-width)]">
        <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Model</DropdownMenuLabel>
        <DropdownMenuItem @select="selectModel('default')">
          Default
          <Check :class="['ml-auto size-3.5', selectedModelId === null ? 'opacity-100' : 'opacity-0']" />
        </DropdownMenuItem>
        <DropdownMenuItem v-for="model in selectedAgent?.models ?? []" :key="model.id" @select="selectModel(model.id)">
          {{ model.label }}
          <Check :class="['ml-auto size-3.5', selectedModelId === model.id ? 'opacity-100' : 'opacity-0']" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu v-if="showTuning || isTerminal">
      <DropdownMenuTrigger as-child>
        <Button type="button" variant="outline" class="min-h-10 w-full justify-between px-3" :disabled="isTerminal || busy" aria-label="Select Effort Or Fast Mode">
          <span class="truncate">{{ tuningLabel }}</span>
          <ChevronDown aria-hidden="true" class="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-[var(--reka-dropdown-menu-trigger-width)]">
        <template v-if="availableEfforts.length">
          <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Effort</DropdownMenuLabel>
          <DropdownMenuItem @select="selectedEffort = null">
            Default
            <Check :class="['ml-auto size-3.5', selectedEffort === null ? 'opacity-100' : 'opacity-0']" />
          </DropdownMenuItem>
          <DropdownMenuItem v-for="effort in availableEfforts" :key="effort" @select="selectedEffort = effort">
            {{ effort[0]?.toUpperCase() }}{{ effort.slice(1) }}
            <Check :class="['ml-auto size-3.5', selectedEffort === effort ? 'opacity-100' : 'opacity-0']" />
          </DropdownMenuItem>
        </template>
        <DropdownMenuSeparator v-if="availableEfforts.length && supportsFast" />
        <template v-if="supportsFast">
          <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Fast Mode</DropdownMenuLabel>
          <DropdownMenuItem @select="fast = true">
            <Zap aria-hidden="true" class="size-4" />
            On
            <Check :class="['ml-auto size-3.5', fast ? 'opacity-100' : 'opacity-0']" />
          </DropdownMenuItem>
          <DropdownMenuItem @select="fast = false">
            Off
            <Check :class="['ml-auto size-3.5', !fast ? 'opacity-100' : 'opacity-0']" />
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
    <div v-else-if="!compact" class="hidden sm:block" aria-hidden="true" />

    <Button type="button" class="min-h-10 px-5 transition-transform active:scale-[0.96]" :disabled="busy || disabled" @click="emit('start', launchSelection())">
      {{ busy ? "Starting" : "Start" }}
      <ArrowRight aria-hidden="true" class="size-4" />
    </Button>
  </div>

  <Alert v-if="error" variant="destructive" aria-atomic="true" class="mt-3">
    <CircleAlert aria-hidden="true" />
    <AlertTitle>Couldn't Load Agents</AlertTitle>
    <AlertDescription class="flex items-center justify-between gap-3 text-pretty">
      <span>Verne couldn't check installed agents. Terminal is still available.</span>
      <Button type="button" variant="outline" class="min-h-10 shrink-0" :disabled="busy || loading" @click="loadAgentChoices">Retry</Button>
    </AlertDescription>
  </Alert>
</template>
