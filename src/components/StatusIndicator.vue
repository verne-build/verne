<script setup lang="ts">
import { computed } from "vue";
import { Check, CircleAlert, LoaderCircle } from "@lucide/vue";
import StatusDot from "./StatusDot.vue";
import type { DisplayState } from "@/lib/agentStatus";

// Single source of truth for the per-state agent status glyph + color. Used by the
// Agents panel and the terminal tab bar. Size comes from the caller's class (e.g.
// size-3); color is applied here.
const props = defineProps<{ state: DisplayState }>();

const MAP = {
  working: { icon: LoaderCircle, color: "text-sky-400", stroke: 3 },
  blocked: { icon: CircleAlert, color: "text-amber-400", stroke: 3 },
  done: { icon: Check, color: "text-violet-400", stroke: 3 },
  idle: { icon: Check, color: "text-green-400", stroke: 3 },
  unknown: { icon: StatusDot, color: "text-muted-foreground/40", stroke: 2 },
} as const;

const entry = computed(() => MAP[props.state] ?? MAP.unknown);

// idle/done settle in with a quick grow; working spins; others static.
const growIn = computed(() => props.state === "idle" || props.state === "done");
const spin = computed(() => props.state === "working");
</script>

<template>
  <component
    :is="entry.icon"
    :key="state"
    :class="[
      entry.color,
      { 'animate-spin [animation-duration:2s]': spin, 'animate-in zoom-in-50 duration-300': growIn },
    ]"
    :stroke-width="entry.stroke"
    aria-hidden="true"
  />
</template>
