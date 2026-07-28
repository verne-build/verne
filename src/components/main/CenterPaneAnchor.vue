<script setup lang="ts">
import { inject, onBeforeUnmount, watch, type ComponentPublicInstance } from "vue";
import { centerPaneAnchorRegistryKey } from "./centerPaneAnchorRegistry";

const props = defineProps<{ anchorId: string }>();
const injectedRegistry = inject(centerPaneAnchorRegistryKey);

if (!injectedRegistry) throw new Error("Missing center pane anchor registry");
const registry = injectedRegistry;

let currentElement: HTMLElement | null = null;
let registeredAnchorId: string | null = null;

function unregisterCurrent(): void {
  if (currentElement && registeredAnchorId)
    registry.unregister(registeredAnchorId, currentElement);
  registeredAnchorId = null;
}

function setAnchorElement(element: Element | ComponentPublicInstance | null): void {
  if (element === currentElement) return;
  unregisterCurrent();
  currentElement = element instanceof HTMLElement ? element : null;
  if (!currentElement) return;
  registry.register(props.anchorId, currentElement);
  registeredAnchorId = props.anchorId;
}

watch(() => props.anchorId, (anchorId) => {
  if (registeredAnchorId === anchorId) return;
  unregisterCurrent();
  if (!currentElement) return;
  registry.register(anchorId, currentElement);
  registeredAnchorId = anchorId;
});

onBeforeUnmount(() => {
  unregisterCurrent();
  currentElement = null;
});
</script>

<template>
  <div
    :ref="setAnchorElement"
    class="h-full w-full min-h-0 min-w-0 overflow-hidden"
    :data-center-pane-anchor="anchorId"
  />
</template>
