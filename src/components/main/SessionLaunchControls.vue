<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Bot, Check, ChevronDown, CircleAlert, SquareTerminal, Zap } from "@lucide/vue";
import { useAgentInventory } from "@/composables/useAgentInventory";
import { useTheme } from "@/composables/useTheme";
import { agentIconSurfaceForTheme, findAgentIconForSurface } from "@/composables/useAgentIcon";
import {
  effortsFor,
  filterLaunchAgents,
  supportsFastFor,
  tuningLabel as tuningLabelFor,
  type ModelDefinition,
} from "@/lib/agentRegistry";
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
import { Kbd } from "@/components/ui/kbd";

// Layout is container-driven (`@container` on the root), not prop-driven: the row
// collapses on its own width, so a narrow split pane stacks even when the window is wide.
const props = withDefaults(defineProps<{ busy?: boolean; disabled?: boolean }>(), {
  busy: false,
  disabled: false,
});
const emit = defineEmits<{ start: [selection: AgentLaunchSelection | undefined] }>();
const { getActiveThemeSpec } = useTheme();
const inventory = useAgentInventory();

const agents = computed(() => filterLaunchAgents(inventory.installedKeys.value));
const selectedAgentType = ref<AgentType | "terminal" | null>(null);
const agentSelectionTouched = ref(false);
const selectedModelId = ref<string | null>(null);
const selectedEffort = ref<string | null>(null);
const fast = ref(false);
const loading = computed(() => inventory.loading.value);
const error = computed(() =>
  !inventory.loading.value && inventory.snapshot.value?.refreshError === "discovery",
);

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

const radioOptions = computed(() => agentChoices.value.length > 0
  ? agentChoices.value.map((agent) => ({ value: agent.type as AgentType | "terminal", label: agent.label, icon: agent.icon }))
  : [{ value: "terminal" as AgentType | "terminal", label: "Terminal", icon: undefined }]);

const radioGroup = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);

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
  if (props.busy) return;
  const last = radioOptions.value.length - 1;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") focusRadio(index + 1);
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") focusRadio(index - 1);
  else if (event.key === "Home") focusRadio(0);
  else if (event.key === "End") focusRadio(last);
  else return;
  event.preventDefault();
}

const availableEfforts = computed(() => effortsFor(selectedModel.value));
const supportsFast = computed(() => supportsFastFor(selectedModel.value));
const showTuning = computed(() => availableEfforts.value.length > 0 || supportsFast.value);
const selectedModelLabel = computed(() => selectedModel.value?.label ?? "Model Default");
const tuningLabel = computed(() => tuningLabelFor({
  efforts: availableEfforts.value,
  supportsFast: supportsFast.value,
  effort: selectedEffort.value,
  fast: fast.value,
}));

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
  if (selectedAgentType.value === value) return;
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

function onRadioClick(value: AgentType | "terminal"): void {
  if (props.busy) return;
  selectAgent(value);
}

watch([selectedAgent, selectedModel], compatibleModel);
// Immediate so the first option is checked (and keeps the group's tab stop) while
// the availability probe is still in flight.
watch(radioOptions, (options) => {
  if (options.length && !options.some((option) => option.value === selectedAgentType.value))
    selectedAgentType.value = options[0]!.value;
}, { immediate: true });

const EDITABLE_TARGET_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return EDITABLE_TARGET_TAGS.has(target.tagName) || target.isContentEditable;
}

function isMenuOpen(): boolean {
  return document.querySelector("[data-slot=dropdown-menu-content]") !== null;
}

// The picker pane that owns these controls. Both mount sites focus their own outer
// element, which is an ancestor of `root` — so scoping containment to `root` alone
// would never match after mount. Two concurrent pickers still resolve to two
// different panes, which is what keeps their shortcuts from crossing over.
function ownerPane(): HTMLElement | null {
  return root.value?.closest<HTMLElement>("[data-session-picker]") ?? root.value ?? null;
}

function isOwnRadio(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && !!radioGroup.value?.contains(target)
    && !!target.closest("[role=radio]");
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (!ownerPane()?.contains(document.activeElement)) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (isEditableTarget(event.target)) return;
  if (isMenuOpen()) return;
  if (props.busy) return;

  if (event.key === "Enter") {
    // Skip only when the browser's synthetic click will do something meaningful.
    // Re-activating an already-checked radio is not that.
    if (event.target instanceof HTMLButtonElement && !isOwnRadio(event.target)) return;
    event.preventDefault();
    if (props.disabled) return;
    emit("start", launchSelection());
    return;
  }

  const index = Number(event.key);
  if (!Number.isInteger(index) || index < 1 || index > 9) return;
  const option = radioOptions.value[index - 1];
  if (!option) return;
  event.preventDefault();
  // focusRadio, not selectAgent — the focus ring must follow the selection,
  // otherwise it strands on whichever icon was last clicked.
  focusRadio(index - 1);
}

onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
  <div ref="root" class="@container">
    <!-- Row mode never wraps: the triggers truncate instead, so Start can't get
         orphaned onto a second line. Below @xl the whole row stacks. -->
    <div
      class="flex gap-2 @max-xl:flex-col @max-xl:items-stretch @xl:flex-nowrap @xl:items-center"
      :aria-busy="loading || busy"
    >
      <TooltipProvider :delay-duration="300">
        <div
          ref="radioGroup"
          role="radiogroup"
          aria-label="Agent"
          :aria-disabled="busy || undefined"
          class="inline-flex h-8 shrink-0 items-center gap-1 @xl:-ms-1.5"
        >
          <Tooltip v-for="(option, index) in radioOptions" :key="option.value">
            <TooltipTrigger as-child>
              <button
                type="button"
                role="radio"
                :aria-label="option.label"
                :aria-checked="selectedAgentType === option.value"
                :tabindex="selectedAgentType === option.value ? 0 : -1"
                :aria-disabled="busy || undefined"
                :class="[
                  'inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  selectedAgentType === option.value
                    ? 'border bg-background shadow-xs dark:border-input dark:bg-input/30'
                    : '',
                  busy
                    ? 'cursor-default opacity-50'
                    : selectedAgentType === option.value
                      ? 'opacity-100'
                      : 'opacity-80 hover:bg-border/25 hover:opacity-100',
                ]"
                @click="onRadioClick(option.value)"
                @keydown="onRadioKeydown($event, index)"
              >
                <img v-if="option.icon" :src="option.icon" alt="" class="size-4" />
                <SquareTerminal v-else-if="option.value === 'terminal'" aria-hidden="true" class="size-4" />
                <Bot v-else aria-hidden="true" class="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent class="flex items-center gap-1">
              {{ option.label }}
              <Kbd v-if="index < 9" aria-hidden="true" variant="outline" class="h-4 min-w-0 px-1 text-[10px]">{{ index + 1 }}</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>

      <!-- `@xl:contents` dissolves this pair into the row; stacked, it keeps Model and
           Effort side by side instead of two more full-width rows. -->
      <div class="flex min-w-0 gap-2 @xl:contents">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button type="button" variant="outline" class="h-8 min-w-0 shrink grow basis-0 px-2.5 has-[>svg]:px-2.5 @xl:grow-0 @xl:basis-auto" :disabled="isTerminal || busy" aria-label="Select Model">
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
            <Button type="button" variant="outline" class="h-8 min-w-0 shrink grow basis-0 px-2.5 has-[>svg]:px-2.5 @xl:grow-0 @xl:basis-auto" :disabled="isTerminal || !showTuning || busy" aria-label="Select Effort Or Fast Mode">
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
      </div>

      <Button type="button" variant="outline" class="h-8 px-3 transition-transform active:scale-[0.96] @max-xl:w-full @xl:ms-auto" :disabled="busy || disabled" @click="emit('start', launchSelection())">
        <!-- Label stays "Start" while busy; the disabled state carries the feedback,
             so the button can't change width mid-launch. -->
        Start
        <Kbd aria-hidden="true" variant="outline" class="h-4 min-w-0 px-1 text-[10px]">⏎</Kbd>
      </Button>
    </div>
  </div>

  <Alert v-if="error" variant="destructive" aria-atomic="true" class="mt-3">
    <CircleAlert aria-hidden="true" />
    <AlertTitle>Couldn't Load Agents</AlertTitle>
    <AlertDescription class="flex items-center justify-between gap-3 text-pretty">
      <span>Verne couldn't check installed agents. Terminal is still available.</span>
      <Button type="button" variant="outline" class="min-h-10 shrink-0" :disabled="busy || loading" @click="inventory.refresh">Retry</Button>
    </AlertDescription>
  </Alert>
</template>
