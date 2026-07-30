<script setup lang="ts">
// Hoisted out of SearchPreview so the "no selection" state can show the
// header without also mounting the (heavy, Monaco-backed) preview body —
// see RightPanel's no-match branch.
import { SquareArrowOutUpRight, PanelLeft } from "@lucide/vue";
import PanelLeftFilled from "./icons/PanelLeftFilled.vue";
import type { ContentSearchMatch } from "@/composables/useRpc";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "./ui/tooltip";

const props = defineProps<{
  match: ContentSearchMatch | null;
  listVisible: boolean;
}>();

const emit = defineEmits<{ "update:listVisible": [v: boolean] }>();

function pathParts(relPath: string) {
  const i = relPath.lastIndexOf("/");
  if (i === -1) return { directory: "", filename: relPath };
  return { directory: relPath.slice(0, i + 1), filename: relPath.slice(i + 1) };
}

function openInEditor() {
  const m = props.match;
  if (!m) return;
  window.dispatchEvent(new CustomEvent("open-file-tab", {
    detail: { path: m.path, position: { line: m.line, column: m.column } },
  }));
}
</script>

<template>
  <div
    class="flex h-8 shrink-0 items-center justify-between gap-1 overflow-hidden border-b border-border bg-sidebar px-2 text-xs text-muted-foreground"
  >
    <Button
      size="icon-xs"
      variant="ghost"
      class="text-muted-foreground shrink-0"
      tabindex="0"
      @click="emit('update:listVisible', !listVisible)"
    >
      <PanelLeft v-if="!listVisible" class="size-3.5" />
      <PanelLeftFilled v-else class="size-3.5" />
    </Button>
    <span
      v-if="match"
      :title="match.relPath"
      class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl]"
    >
      <span class="[direction:ltr]">
        <span class="text-muted-foreground">{{ pathParts(match.relPath).directory }}</span>
        <span class="text-foreground">{{ pathParts(match.relPath).filename }}</span>
      </span>
    </span>
    <TooltipProvider v-if="match" :delay-duration="400">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button size="icon-xs" variant="ghost" class="shrink-0" @click="openInEditor">
            <SquareArrowOutUpRight class="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" class="text-xs">Open in Editor</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
</template>
