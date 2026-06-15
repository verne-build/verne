<script setup lang="ts">
import type { Component } from "vue";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

// Compact segmented control. Each option renders its `icon` when given,
// otherwise its `label` as text — so the same control works for an
// icon-only bar or a text-only bar.
export interface SegmentedOption {
  value: string;
  label?: string;
  title?: string;
  icon?: Component;
}

defineProps<{ modelValue: string; options: SegmentedOption[] }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <Tabs
    :model-value="modelValue"
    @update:model-value="(v: string | number) => emit('update:modelValue', String(v))"
  >
    <TabsList class="h-6 bg-transparent border border-border">
      <TabsTrigger
        v-for="opt in options"
        :key="opt.value"
        :value="opt.value"
        :title="opt.title ?? opt.label"
        :aria-label="opt.label ?? opt.title"
        class="px-2 py-0 h-full text-[10px] dark:data-[state=active]:bg-border border-0"
      >
        <component :is="opt.icon" v-if="opt.icon" class="size-3" />
        <template v-else>{{ opt.label }}</template>
      </TabsTrigger>
    </TabsList>
  </Tabs>
</template>
