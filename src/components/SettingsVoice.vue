<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke, listen, type UnlistenFn } from "@/platform";
import { useSettings } from "@/composables/useSettings";
import { useDictation } from "@/composables/useDictation";
import type { VoiceSettings } from "@/types/shared";
import type { SpeechModelManifest, SpeechModelState } from "@/types/speech";
import { Download, Loader2, Trash2 } from "@lucide/vue";
import { Card, CardContent } from "./ui/card";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Kbd, KbdGroup } from "./ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const { settings, update } = useSettings();
const { syncHotkeyConfig } = useDictation();

const DEFAULT_VOICE: VoiceSettings = {
  enabled: false,
  sttModel: "parakeet-tdt-0.6b-v3-int8",
  dictationMode: "toggle",
  hotkey: "CommandOrControl+E",
  language: "auto",
  confirmBeforeInsert: false,
  dictionaryEnabled: true,
  customTerms: "",
  convertNumbers: true,
};

const catalog = ref<SpeechModelManifest[]>([]);
const states = ref<Record<string, SpeechModelState>>({});
const capturing = ref(false);
let unlistenProgress: UnlistenFn | null = null;

type DownloadProgressEvent = Partial<SpeechModelState> & {
  modelId?: string;
};

const isMac = navigator.platform.toLowerCase().includes("mac");
// Pretty-print the stored Electron accelerator (e.g. "CommandOrControl+E") into
// per-key glyphs for the Kbd display.
const KEY_GLYPHS: Record<string, string> = {
  CommandOrControl: isMac ? "⌘" : "Ctrl",
  Command: "⌘",
  Control: isMac ? "⌃" : "Ctrl",
  Alt: isMac ? "⌥" : "Alt",
  Option: "⌥",
  Shift: "⇧",
  Meta: "⌘",
};
const hotkeyKeys = computed(() =>
  (settings.value.voice?.hotkey ?? DEFAULT_VOICE.hotkey)
    .split("+")
    .map((k) => KEY_GLYPHS[k] ?? k),
);

async function refreshStates() {
  const list = await invoke<SpeechModelState[]>("speech:getModelStates");
  states.value = Object.fromEntries(list.map((s) => [s.id, s]));
}

onMounted(async () => {
  catalog.value = await invoke<SpeechModelManifest[]>("speech:getCatalog");
  await refreshStates();
  unlistenProgress = await listen<DownloadProgressEvent>(
    "speech:downloadProgress",
    (e) => {
      const { progress, error } = e.payload;
      const modelId = e.payload.modelId ?? e.payload.id;
      if (!modelId) return;

      const status =
        e.payload.status ?? (progress != null && progress >= 0.95 ? "extracting" : "downloading");
      const cur = states.value[modelId] ?? { id: modelId, status };
      states.value = {
        ...states.value,
        [modelId]: { ...cur, status, progress, error },
      };
    },
  );
});

onUnmounted(() => unlistenProgress?.());

async function setVoice(partial: Partial<VoiceSettings>) {
  const next: VoiceSettings = { ...DEFAULT_VOICE, ...settings.value.voice, ...partial };
  await update({ voice: next });
  await syncHotkeyConfig();
}

async function download(id: string) {
  states.value = { ...states.value, [id]: { id, status: "downloading", progress: 0 } };
  try {
    await invoke("speech:downloadModel", { modelId: id });
  } catch (err) {
    states.value = {
      ...states.value,
      [id]: { id, status: "error", error: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    await refreshStates();
  }
}

async function remove(id: string) {
  await invoke("speech:deleteModel", { modelId: id });
  await refreshStates();
}

function startHotkeyCapture() {
  capturing.value = true;
  const handler = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
    const parts: string[] = [];
    if (e.metaKey || (e.ctrlKey && !isMac)) parts.push("CommandOrControl");
    else if (e.ctrlKey) parts.push("Control");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    void setVoice({ hotkey: parts.join("+") });
    capturing.value = false;
    window.removeEventListener("keydown", handler, true);
  };
  window.addEventListener("keydown", handler, true);
}

function fmtSize(bytes: number) {
  return `${Math.round(bytes / 1e6)} MB`;
}
function modelState(id: string): SpeechModelState {
  return states.value[id] ?? { id, status: "not-downloaded" };
}
function statusOf(id: string): SpeechModelState["status"] {
  return modelState(id).status;
}
function progressPercent(id: string) {
  return Math.round((modelState(id).progress ?? 0) * 100);
}
function isBusy(id: string) {
  return statusOf(id) === "downloading" || statusOf(id) === "extracting";
}
function modelStatusLabel(id: string) {
  const state = modelState(id);
  if (state.status === "downloading") return `Downloading ${progressPercent(id)}%`;
  if (state.status === "extracting") return `Installing ${progressPercent(id)}%`;
  if (state.status === "error") return "Download failed";
  if (state.status === "ready") return settings.value.voice?.sttModel === id ? "Selected" : "Installed";
  return "Not downloaded";
}
</script>

<template>
  <h2 class="text-lg font-semibold mb-6">Voice</h2>

  <Card class="!py-0 !gap-0 bg-popover">
    <CardContent class="!p-0">
      <div class="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <div class="text-sm font-medium">Enable voice dictation</div>
          <div class="text-xs text-muted-foreground">
            Press the hotkey, speak, and the transcript is inserted into the focused terminal or editor.
          </div>
        </div>
        <Switch
          :model-value="settings.voice?.enabled ?? false"
          tabindex="0"
          @update:model-value="(v: boolean) => setVoice({ enabled: v })"
        />
      </div>

      <div class="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <div class="text-sm font-medium">Mode</div>
          <div class="text-xs text-muted-foreground">
            Toggle: press once to start, again to stop. Hold: dictate while the key is held.
          </div>
        </div>
        <ToggleGroup
          variant="outline"
          size="sm"
          :model-value="settings.voice?.dictationMode ?? 'toggle'"
          @update:model-value="(v) => v && setVoice({ dictationMode: v as 'toggle' | 'hold' })"
        >
          <ToggleGroupItem value="toggle">Toggle</ToggleGroupItem>
          <ToggleGroupItem value="hold">Hold</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div class="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <div class="text-sm font-medium">Hotkey</div>
          <div class="text-xs text-muted-foreground">Keyboard shortcut that triggers dictation.</div>
        </div>
        <Button variant="outline" size="sm" class="min-w-24" @click="startHotkeyCapture">
          <span v-if="capturing" class="text-muted-foreground">Press keys…</span>
          <KbdGroup v-else>
            <Kbd v-for="(k, i) in hotkeyKeys" :key="i">{{ k }}</Kbd>
          </KbdGroup>
        </Button>
      </div>

      <div class="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <div class="text-sm font-medium">Convert spoken numbers to digits</div>
          <div class="text-xs text-muted-foreground">
            Write “three hundred and fifty” as 350, “twenty five” as 25, “three point one four” as 3.14.
          </div>
        </div>
        <Switch
          :model-value="settings.voice?.convertNumbers !== false"
          tabindex="0"
          @update:model-value="(v: boolean) => setVoice({ convertNumbers: v })"
        />
      </div>

      <div
        class="flex items-center justify-between px-6 py-4"
        :class="settings.voice?.dictionaryEnabled !== false ? 'border-b border-border' : ''"
      >
        <div>
          <div class="text-sm font-medium">Developer term replacement</div>
          <div class="text-xs text-muted-foreground">
            Rewrite spoken phrases into proper terms (e.g. “next js” → Next.js, “megabytes” → MB).
          </div>
        </div>
        <Switch
          :model-value="settings.voice?.dictionaryEnabled !== false"
          tabindex="0"
          @update:model-value="(v: boolean) => setVoice({ dictionaryEnabled: v })"
        />
      </div>

      <div v-if="settings.voice?.dictionaryEnabled !== false" class="px-6 py-4">
        <div class="text-sm font-medium mb-1">Custom replacements</div>
        <div class="text-xs text-muted-foreground mb-2">
          One rule per line, as <span class="font-mono">spoken =&gt; Replacement</span>. Applied before
          the built-in list. Lines starting with # are ignored.
        </div>
        <Textarea
          :model-value="settings.voice?.customTerms ?? ''"
          :rows="5"
          spellcheck="false"
          placeholder="kubernetes => Kubernetes&#10;post gres => PostgreSQL&#10;web socket => WebSocket"
          class="text-xs font-mono resize-y"
          @change="(e: Event) => setVoice({ customTerms: (e.target as HTMLTextAreaElement).value })"
        />
      </div>
    </CardContent>
  </Card>

  <h3 class="text-sm font-bold mt-6 mb-3">Speech Models</h3>
  <Card class="!py-0 !gap-0 bg-popover">
    <CardContent class="!p-0">
      <div
        v-for="m in catalog"
        :key="m.id"
        class="px-6 py-4 border-b border-border last:border-b-0"
        :class="settings.voice?.sttModel === m.id ? 'bg-accent/30' : ''"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ m.label }}</div>
            <div class="mt-0.5 text-xs text-muted-foreground">{{ m.description }}</div>
          </div>

          <div v-if="statusOf(m.id) === 'ready'" class="flex shrink-0 items-center">
            <Button
              v-if="settings.voice?.sttModel !== m.id"
              variant="outline"
              size="sm"
              @click="setVoice({ sttModel: m.id })"
            >
              Select
            </Button>
            <Button v-else size="sm" aria-disabled="true" tabindex="-1" class="pointer-events-none">
              Selected
            </Button>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
          <div class="text-[11px] text-muted-foreground">
            {{ m.language }} · {{ fmtSize(m.sizeBytes) }}
          </div>

          <Button v-if="isBusy(m.id)" variant="outline" size="xs" disabled class="min-w-[7.5rem]">
            <Loader2 class="size-3.5 animate-spin" />
            {{ modelStatusLabel(m.id) }}
          </Button>
          <Button v-else-if="statusOf(m.id) === 'ready'" variant="ghost" size="xs" @click="remove(m.id)">
            <Trash2 class="size-3" />
            Delete
          </Button>
          <Button v-else variant="outline" size="xs" @click="download(m.id)">
            <Download class="size-3" />
            {{ statusOf(m.id) === "error" ? "Retry" : "Download" }}
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
