<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { convertFileSrc, invoke } from "@/platform";
import { toast } from "vue-sonner";
import { Button } from "../ui/button";
import { AlertTriangle, ExternalLink, Music } from "@lucide/vue";

const props = defineProps<{ path: string; kind: "video" | "audio" }>();

const media = ref<HTMLMediaElement | null>(null);
const failed = ref(false);
const src = computed(() => convertFileSrc(props.path));
const label = computed(() => props.path.split(/[\\/]/).pop() ?? props.path);

watch(() => props.path, () => { failed.value = false; });

function onError() {
  failed.value = true;
}

// FileEditorTab is KeepAlive'd: switching to another tab deactivates instead of
// unmounting, so pause explicitly or audio would keep playing in the background.
onDeactivated(() => {
  media.value?.pause();
});

onBeforeUnmount(() => {
  const el = media.value;
  if (!el) return;
  el.pause();
  el.removeAttribute("src");
  el.load();
});

function openExternally() {
  void invoke("open_path", { path: props.path }).catch((e) => toast.error(String(e)));
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-background p-4">
    <template v-if="!failed">
      <video
        v-if="kind === 'video'"
        :key="path"
        ref="media"
        :src="src"
        controls
        playsinline
        preload="metadata"
        class="max-h-full max-w-full rounded-md bg-black shadow-sm"
        @error="onError"
      />
      <div v-else class="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border border-border bg-sidebar p-6">
        <Music class="size-8 text-muted-foreground" />
        <div class="w-full truncate text-center text-xs text-muted-foreground">{{ label }}</div>
        <audio
          :key="path"
          ref="media"
          :src="src"
          controls
          preload="metadata"
          class="w-full"
          @error="onError"
        />
      </div>
    </template>

    <div v-else class="flex flex-col items-center gap-3 text-center">
      <AlertTriangle class="size-6 text-muted-foreground" />
      <div class="text-sm text-foreground">This file can't be played here</div>
      <div class="max-w-sm text-xs text-muted-foreground">
        The container or codec isn't supported by Chromium (e.g. HEVC, MKV, AVI). Open it in your default app instead.
      </div>
      <Button size="sm" variant="outline" @click="openExternally">
        <ExternalLink class="size-3.5" /> Open in Default App
      </Button>
    </div>
  </div>
</template>
