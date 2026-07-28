<script setup lang="ts">
import { SquarePen } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcuts } from "@/composables/useShortcuts";

const emit = defineEmits<{ (event: "new-session"): void }>();
const shortcuts = useShortcuts();
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground hover:text-foreground"
          aria-label="New Session"
          @click="emit('new-session')"
        >
          <SquarePen class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" class="flex items-center gap-2">
        <span>New Session</span>
        <KbdGroup>
          <Kbd v-for="(key, i) in shortcuts.displayKeys('new-terminal')" :key="i">{{ key }}</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
