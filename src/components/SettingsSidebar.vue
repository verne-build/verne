<script setup lang="ts">
import { ArrowLeft, Palette, SlidersHorizontal, Code, Terminal, FolderClosed, FolderTree, Languages, Bot, Mic, Bell } from "@lucide/vue";
import { useSettingsNav } from "@/composables/useSettingsNav";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

defineEmits<{ close: []; fluxCapacitor: [] }>();
const { activeCategory } = useSettingsNav();

const categories = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "workspace", label: "Workspace", icon: SlidersHorizontal },
  { id: "editor", label: "Editor", icon: Code },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "files", label: "Files", icon: FolderClosed },
  { id: "directories", label: "Directories", icon: FolderTree },
  { id: "languages", label: "Languages", icon: Languages },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "mcp", label: "Agents", icon: Bot },
  { id: "notifications", label: "Notifications", icon: Bell },
];
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex flex-col gap-1 px-1 pb-2">
      <Button
        variant="ghost"
        size="sm"
        class="w-full justify-start text-xs font-medium text-soft-foreground"
        tabindex="0"
        @click="$emit('close')"
      >
        <ArrowLeft class="size-3 shrink-0" />
        Back to app
      </Button>
    </div>
    <nav class="flex flex-col gap-0.5 px-1 flex-1">
      <Button
        v-for="cat in categories"
        :key="cat.id"
        variant="ghost"
        size="sm"
        class="w-full justify-start text-xs font-medium"
        :class="activeCategory === cat.id ? 'bg-accent text-accent-foreground' : 'text-soft-foreground'"
        tabindex="0"
        @click="activeCategory = cat.id"
      >
        <component
          :is="cat.icon"
          class="size-3 shrink-0"
        />
        {{ cat.label }}
      </Button>
    </nav>
    <div class="px-3 pb-3 text-muted-foreground">
      <TooltipProvider :delay-duration="0">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              @click="$emit('fluxCapacitor')"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="4" />
                <circle cx="8" cy="7" r="2" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="12" cy="17" r="2" />
                <circle cx="12" cy="12" r="0.75" fill="currentColor" />
                <line x1="9.4" y1="8.6" x2="11.3" y2="11.3" />
                <line x1="14.6" y1="8.6" x2="12.7" y2="11.3" />
                <line x1="12" y1="12.75" x2="12" y2="15" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">If my calculations are correct...</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  </div>
</template>
