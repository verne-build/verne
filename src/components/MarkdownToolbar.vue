<script setup lang="ts">
import {
  Bold, Italic, Code, Link, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Quote, SquareCode, Table,
} from "@lucide/vue";
import type { Component } from "vue";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Separator } from "./ui/separator";
import type { FormatAction } from "@/lib/markdownFormat";

const emit = defineEmits<{ action: [FormatAction] }>();

interface Item {
  action: FormatAction;
  icon: Component;
  label: string;
}

const groups: Item[][] = [
  [
    { action: "h1", icon: Heading1, label: "Heading 1" },
    { action: "h2", icon: Heading2, label: "Heading 2" },
    { action: "h3", icon: Heading3, label: "Heading 3" },
  ],
  [
    { action: "bold", icon: Bold, label: "Bold" },
    { action: "italic", icon: Italic, label: "Italic" },
    { action: "code", icon: Code, label: "Inline Code" },
    { action: "link", icon: Link, label: "Link" },
  ],
  [
    { action: "bullet", icon: List, label: "Bulleted List" },
    { action: "numbered", icon: ListOrdered, label: "Numbered List" },
    { action: "task", icon: ListChecks, label: "Task List" },
    { action: "quote", icon: Quote, label: "Quote" },
    { action: "codeblock", icon: SquareCode, label: "Code Block" },
    { action: "table", icon: Table, label: "Table" },
  ],
];
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div
      class="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border)] bg-[var(--editor-bg)] px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <template v-for="(group, gi) in groups" :key="gi">
        <Separator v-if="gi > 0" orientation="vertical" class="mx-1 h-4 shrink-0" />
        <Tooltip v-for="item in group" :key="item.action">
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              tabindex="-1"
              @click="emit('action', item.action)"
            >
              <component :is="item.icon" class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ item.label }}</TooltipContent>
        </Tooltip>
      </template>
    </div>
  </TooltipProvider>
</template>
