<script setup lang="ts">
import { CircleHelp, Settings } from "@lucide/vue";
import SessionsSidebar from "./SessionsSidebar.vue";
import ResourceMonitor from "@/components/ResourceMonitor.vue";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcuts } from "@/composables/useShortcuts";

const emit = defineEmits<{ (e: "open-settings"): void; (e: "open-shortcuts"): void }>();
const shortcuts = useShortcuts();
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex min-h-0 flex-1 flex-col">
      <SessionsSidebar />
    </div>
    <footer class="flex shrink-0 items-center justify-end gap-0.5 border-t border-border px-1 py-1">
      <TooltipProvider :delay-duration="300">
        <span class="contents" data-control="resource-monitor">
          <ResourceMonitor />
        </span>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground hover:text-foreground"
              data-control="keyboard-shortcuts"
              @click="emit('open-shortcuts')"
            >
              <CircleHelp class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" class="flex items-center gap-2">
            <span>Keyboard Shortcuts</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('shortcuts-help')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground hover:text-foreground"
              data-control="settings"
              @click="emit('open-settings')"
            >
              <Settings class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" class="flex items-center gap-2">
            <span>Settings</span>
            <KbdGroup>
              <Kbd v-for="(key, i) in shortcuts.displayKeys('settings')" :key="i">{{ key }}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </footer>
  </div>
</template>
