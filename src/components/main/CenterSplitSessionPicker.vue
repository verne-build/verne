<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { CircleAlert, X } from "@lucide/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import type { AgentLaunchSelection } from "@/types";
import SessionLaunchControls from "@/components/main/SessionLaunchControls.vue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  directoryId: string;
  pickerId: string;
  sourceSessionId: string;
  reserveLeftOverlay?: boolean;
  reserveRightOverlay?: boolean;
}>();
const store = useWorkspaceStore();
const root = ref<HTMLElement | null>(null);
const headingId = computed(() => `center-split-picker-title-${props.pickerId.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
const localLaunching = ref(false);
const launching = computed(() => localLaunching.value || store.isCenterSplitPickerLaunching(props.pickerId));
const launchError = ref<string | null>(null);
const pendingSelection = ref<AgentLaunchSelection | undefined>();

function close(): void {
  if (launching.value) return;
  store.cancelCenterSplitPicker(props.directoryId, props.pickerId);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || launching.value) return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

async function launch(selection: AgentLaunchSelection | undefined): Promise<void> {
  if (launching.value) return;
  pendingSelection.value = selection;
  localLaunching.value = true;
  launchError.value = null;
  try {
    await store.startCenterSplitPicker({
      directoryId: props.directoryId,
      pickerId: props.pickerId,
      sourceSessionId: props.sourceSessionId,
      agentLaunch: selection,
    });
  } catch (error) {
    launchError.value = error instanceof Error && error.message
      ? error.message
      : "Verne couldn't start this session. Try again.";
  } finally {
    localLaunching.value = false;
  }
}

onMounted(() => {
  void nextTick(() => root.value?.focus());
});
</script>

<template>
  <section ref="root" data-session-picker tabindex="-1" class="flex h-full min-h-0 flex-col bg-background outline-none" :aria-labelledby="headingId" @keydown="onKeydown">
    <header :class="['drag-region flex h-11.5 shrink-0 items-center gap-1.5 overflow-hidden border-b bg-sidebar text-xs', reserveLeftOverlay ? 'pl-[133px]' : 'pl-4', reserveRightOverlay ? 'pr-14' : 'pr-1']">
      <h2 :id="headingId" class="flex-1 truncate leading-none">New Session</h2>
      <Button
        data-no-drag
        type="button"
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        aria-label="Close New Session"
        :disabled="launching"
        @click="close"
      >
        <X aria-hidden="true" class="size-3.5" />
      </Button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
      <div class="mx-auto flex min-h-full w-full max-w-sm items-center">
        <div class="w-full">
          <SessionLaunchControls compact :busy="launching" @start="launch" />
          <Alert v-if="launchError" variant="destructive" aria-atomic="true" class="mt-3">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Couldn't Start Session</AlertTitle>
            <AlertDescription class="space-y-3 text-pretty">
              <p>{{ launchError }}</p>
              <Button type="button" variant="outline" class="min-h-10" :disabled="launching" @click="launch(pendingSelection)">
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    </div>
  </section>
</template>
