<script setup lang="ts">
import { PanelLeft, MoreHorizontal, Rows3, Columns2, Check, Undo2, GitBranch, History } from "@lucide/vue";
import PanelLeftFilled from "./icons/PanelLeftFilled.vue";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import SegmentedTabs, { type SegmentedOption } from "./SegmentedTabs.vue";

const props = defineProps<{
  listVisible: boolean;
  relPath: string | null;
  commitShortId?: string | null;
  stats?: { added: number; deleted: number } | null;
  layout: "unified" | "split";
  canRevert?: boolean;
  view?: "changes" | "history";
}>();

const emit = defineEmits<{
  "update:listVisible": [v: boolean];
  "update:layout": [v: "unified" | "split"];
  revert: [];
  "update:view": [v: "changes" | "history"];
}>();

const viewTabOptions: SegmentedOption[] = [
  { value: "changes", label: "Changes", icon: GitBranch },
  { value: "history", label: "History", icon: History },
];

function diffPathParts(path: string) {
  const slash = path.lastIndexOf("/");
  return {
    directory: slash >= 0 ? path.slice(0, slash + 1) : "",
    filename: slash >= 0 ? path.slice(slash + 1) : path,
  };
}
</script>

<template>
  <div
    class="flex items-center justify-between px-2 h-8 text-xs text-muted-foreground bg-sidebar border-b border-border overflow-hidden shrink-0 gap-1"
  >
    <div class="flex min-w-0 flex-1 items-center gap-1">
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
      <SegmentedTabs
        v-if="view"
        :model-value="view"
        :options="viewTabOptions"
        class="shrink-0"
        @update:model-value="(v) => emit('update:view', v as 'changes' | 'history')"
      />
      <span
        v-if="relPath"
        :title="relPath"
        class="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap [direction:rtl]"
        :class="{ 'ml-2': view }"
      ><span class="[direction:ltr]"><span class="text-muted-foreground">{{ diffPathParts(relPath).directory }}</span><span class="text-foreground">{{ diffPathParts(relPath).filename }}</span></span></span>
    </div>
    <div v-if="relPath" class="flex items-center gap-2 shrink-0 ml-3">
      <span v-if="commitShortId" class="opacity-50 text-[10px]">{{ commitShortId }}</span>
      <span v-if="stats" class="font-mono text-[10px]">
        <Badge class="text-green-400 bg-green-400/10 text-[10px] py-0 px-1 rounded-r-none">
          +{{ stats.added }}
        </Badge>
        <Badge class="text-red-400 bg-red-400/10 text-[10px] py-0 px-1 rounded-l-none">
          -{{ stats.deleted }}
        </Badge>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button size="icon-xs" variant="ghost" aria-label="Diff options">
            <MoreHorizontal class="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" size="sm" class="min-w-40">
          <DropdownMenuItem @select="emit('update:layout', 'unified')">
            <Rows3 class="size-3.5" />
            Unified
            <Check :class="['ml-auto size-3.5', layout === 'unified' ? 'opacity-100' : 'opacity-0']" />
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('update:layout', 'split')">
            <Columns2 class="size-3.5" />
            Split
            <Check :class="['ml-auto size-3.5', layout === 'split' ? 'opacity-100' : 'opacity-0']" />
          </DropdownMenuItem>
          <template v-if="canRevert">
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="emit('revert')">
              <Undo2 class="size-3.5" />
              Revert File
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
