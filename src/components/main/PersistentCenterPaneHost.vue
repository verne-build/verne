<script setup lang="ts">
import type { CenterPanePlacement } from "@/lib/centerPanePlacement";
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import TerminalPane from "./TerminalPane.vue";
import { centerPaneAnchorRegistryKey } from "./centerPaneAnchorRegistry";

const props = defineProps<{ placements: CenterPanePlacement[] }>();
const injectedRegistry = inject(centerPaneAnchorRegistryKey);

if (!injectedRegistry) throw new Error("Missing center pane anchor registry");
const registry = injectedRegistry;

const parkingContainer = ref<HTMLElement | null>(null);
const parkingElement = document.createElement("div");
parkingElement.hidden = true;
parkingElement.setAttribute("aria-hidden", "true");
parkingElement.dataset.centerPaneParking = "true";

interface UnavailablePane {
  key: string;
  anchorId: string;
}

const unavailablePanes = shallowRef<UnavailablePane[]>([]);
const pendingMissingRetries = new Map<string, symbol>();
let generation = 0;
let focusToken: symbol | null = null;
let ownsHost = true;

const resolvedTargets = computed(() => {
  void registry.revision.value;
  return new Map(props.placements.map((placement) => [
    placement.paneId,
    registry.target(placement.anchorId) ?? parkingElement,
  ]));
});

function placementKey(placement: Pick<CenterPanePlacement, "paneId" | "anchorId">): string {
  return `${placement.paneId}\u0000${placement.anchorId}`;
}

function targetFor(placement: CenterPanePlacement): HTMLElement {
  return resolvedTargets.value.get(placement.paneId) ?? parkingElement;
}

function unavailableLabel(anchorId: string): string {
  return `Terminal pane unavailable: ${anchorId}`;
}

function isCurrentPlacement(key: string): boolean {
  return props.placements.some((placement) => placementKey(placement) === key);
}

function setUnavailable(next: UnavailablePane[]): void {
  const current = unavailablePanes.value;
  if (
    current.length === next.length
    && current.every((pane, index) => pane.key === next[index]?.key)
  ) return;
  unavailablePanes.value = next;
}

function syncMissingTargets(): void {
  if (!ownsHost) return;
  const missing = new Map<string, CenterPanePlacement>();
  for (const placement of props.placements) {
    if (!registry.target(placement.anchorId))
      missing.set(placementKey(placement), placement);
  }

  for (const key of pendingMissingRetries.keys()) {
    if (!missing.has(key)) pendingMissingRetries.delete(key);
  }
  setUnavailable(unavailablePanes.value.filter(({ key }) => missing.has(key)));

  for (const [key, placement] of missing) {
    if (
      pendingMissingRetries.has(key)
      || unavailablePanes.value.some((unavailable) => unavailable.key === key)
    ) continue;

    const retryToken = Symbol(key);
    const retryGeneration = generation;
    pendingMissingRetries.set(key, retryToken);
    void nextTick().then(() => {
      if (
        !ownsHost
        || generation !== retryGeneration
        || pendingMissingRetries.get(key) !== retryToken
        || !isCurrentPlacement(key)
      ) return;
      pendingMissingRetries.delete(key);
      if (registry.target(placement.anchorId)) return;
      setUnavailable([
        ...unavailablePanes.value,
        { key, anchorId: placement.anchorId },
      ]);
    });
  }
}

function scheduleFocusRestore(): void {
  const restoreGeneration = generation;
  const restoreToken = Symbol("focus");
  const retained = props.placements.map(({ paneId, anchorId }) => ({
    paneId,
    anchorId,
    key: placementKey({ paneId, anchorId }),
  }));
  focusToken = restoreToken;

  void nextTick().then(() => {
    if (
      !ownsHost
      || generation !== restoreGeneration
      || focusToken !== restoreToken
    ) return;
    focusToken = null;
    for (const placement of retained) {
      if (
        isCurrentPlacement(placement.key)
        && registry.target(placement.anchorId)
      ) registry.restoreCapturedFocus(placement.anchorId);
    }
  });
}

watch(
  () => props.placements.map(placementKey).join("\u0001"),
  () => {
    generation += 1;
    focusToken = null;
    pendingMissingRetries.clear();
    syncMissingTargets();
  },
  { flush: "post", immediate: true },
);

watch(registry.revision, () => {
  syncMissingTargets();
  scheduleFocusRestore();
}, { flush: "post" });

onMounted(() => {
  parkingContainer.value?.append(parkingElement);
});

onBeforeUnmount(() => {
  ownsHost = false;
  generation += 1;
  focusToken = null;
  pendingMissingRetries.clear();
  unavailablePanes.value = [];
  parkingElement.remove();
});
</script>

<template>
  <div data-persistent-center-pane-host>
    <Teleport
      v-for="placement in placements"
      :key="placement.paneId"
      :to="targetFor(placement)"
    >
      <TerminalPane
        :key="placement.paneId"
        :pane-id="placement.paneId"
        :scope-id="placement.scopeId"
        :focused-session-id="placement.focusedSessionId"
        :multi="placement.multi"
        :reserve-left-overlay="placement.reserveLeftOverlay"
        :reserve-right-overlay="placement.reserveRightOverlay"
      />
    </Teleport>
    <div
      ref="parkingContainer"
      hidden
      inert
      aria-hidden="true"
      data-center-pane-parking-container
    />
    <div
      v-for="unavailable in unavailablePanes"
      :key="unavailable.key"
      role="status"
      v-text="unavailableLabel(unavailable.anchorId)"
    />
  </div>
</template>
