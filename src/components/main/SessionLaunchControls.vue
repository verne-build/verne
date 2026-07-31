<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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

const radioOptions = computed(() => [
  ...agentChoices.value.map((agent) => ({ value: agent.type as AgentType | "terminal", label: agent.label, icon: agent.icon })),
  { value: "terminal" as AgentType | "terminal", label: "Terminal", icon: undefined },
]);

const radioGroup = ref<HTMLElement | null>(null);

function focusRadio(index: number): void {
  const options = radioOptions.value;
  if (!options.length) return;
  const next = ((index % options.length) + options.length) % options.length;
  selectAgent(options[next]!.value);
  void nextTick(() => {
    radioGroup.value?.querySelectorAll<HTMLButtonElement>("button[role=radio]")[next]?.focus();
  });
}

function onRadioKeydown(event: KeyboardEvent, index: number): void {
  const last = radioOptions.value.length - 1;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") focusRadio(index + 1);
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") focusRadio(index - 1);
  else if (event.key === "Home") focusRadio(0);
  else if (event.key === "End") focusRadio(last);
  else return;
  event.preventDefault();
}

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
const selectedModelLabel = computed(() => selectedModel.value?.label ?? "Model Default");
const tuningLabel = computed(() => {
  const labels: string[] = [];
  if (availableEfforts.value.length > 0 || !showTuning.value)
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
  <div :class="['flex gap-2', compact ? 'flex-col items-stretch' : 'flex-wrap items-center']" :aria-busy="loading || busy">
    <TooltipProvider :delay-duration="300">
      <div
        ref="radioGroup"
        role="radiogroup"
        aria-label="Agent"
        :aria-disabled="busy || undefined"
        class="-ms-1.5 inline-flex h-8 shrink-0 items-center gap-1"
      >
        <Tooltip v-for="(option, index) in radioOptions" :key="option.value">
          <TooltipTrigger as-child>
            <button
              type="button"
              role="radio"
              :aria-label="option.label"
              :aria-checked="selectedAgentType === option.value"
              :tabindex="selectedAgentType === option.value ? 0 : -1"
              :disabled="busy"
              :class="[
                'inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                selectedAgentType === option.value ? 'bg-secondary opacity-100' : 'opacity-55 hover:opacity-100 hover:bg-border/25',
              ]"
              @click="selectAgent(option.value)"
              @keydown="onRadioKeydown($event, index)"
            >
              <img v-if="option.icon" :src="option.icon" alt="" class="size-4" />
              <SquareTerminal v-else-if="option.value === 'terminal'" aria-hidden="true" class="size-4" />
              <Bot v-else aria-hidden="true" class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{{ option.label }}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button type="button" variant="outline" class="h-8 min-w-0 px-2.5" :disabled="isTerminal || busy" aria-label="Select Model">
          <span class="truncate">{{ selectedModelLabel }}</span>
          <ChevronDown aria-hidden="true" class="size-3.5 text-muted-foreground" />
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

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button type="button" variant="outline" class="h-8 min-w-0 px-2.5" :disabled="isTerminal || !showTuning || busy" aria-label="Select Effort Or Fast Mode">
          <span class="truncate">{{ tuningLabel }}</span>
          <ChevronDown aria-hidden="true" class="size-3.5 text-muted-foreground" />
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

    <Button type="button" :class="['h-8 px-4 transition-transform active:scale-[0.96]', compact ? 'w-full' : 'ms-auto']" :disabled="busy || disabled" @click="emit('start', launchSelection())">
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
