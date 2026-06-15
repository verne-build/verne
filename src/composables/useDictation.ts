import { ref } from "vue";
import { toast } from "vue-sonner";
import { convertFileSrc, invoke, listen } from "@/platform";
import { useSettings } from "./useSettings";
import { startAudioCapture, type AudioCapture } from "./useAudioCapture";
import { captureTarget, insertText, type InsertionTarget } from "@/lib/dictationInsertionTarget";
import {
  attachSpokenDotToPreviousNumber,
  formatFinalTranscriptSegment,
  isDuplicateFinalTranscriptSegment,
} from "@/lib/dictationFinalSegments";
import { applyDictationDictionary, buildDictationRules } from "@/lib/dictationDictionary";
import { convertSpokenNumbers } from "@/lib/dictationNumbers";

export type DictationState = "idle" | "starting" | "listening" | "stopping" | "error";

const SESSION = "desktop";

// Module-level singleton state so the overlay and any trigger share one machine.
const state = ref<DictationState>("idle");
const partial = ref("");
const errorMessage = ref("");

let capture: AudioCapture | null = null;
let target: InsertionTarget = { kind: "none" };
let ready = false;
let insertedThisSession = "";
let lastFinalText = "";
let wired = false;
let listeningSound: HTMLAudioElement | null = null;
let listeningSoundPromise: Promise<HTMLAudioElement | null> | null = null;

export function useDictation() {
  const { settings } = useSettings();

  async function cleanup(): Promise<void> {
    if (capture) {
      await capture.stop().catch(() => {});
      capture = null;
    }
    ready = false;
  }

  async function start(): Promise<void> {
    if (state.value !== "idle") return;
    const voice = settings.value.voice;
    if (!voice?.enabled || !voice.sttModel) return;
    state.value = "starting";
    ready = false;
    partial.value = "";
    insertedThisSession = "";
    lastFinalText = "";
    target = captureTarget();
    console.debug("[dictation] start: model=", voice.sttModel, "target=", target.kind);
    try {
      capture = await startAudioCapture(SESSION, () => ready);
      await invoke("speech:startDictation", { modelId: voice.sttModel, sessionId: SESSION });
      console.debug("[dictation] startDictation resolved (worker ready)");
    } catch (e) {
      errorMessage.value = e instanceof Error ? e.message : String(e);
      console.error("[dictation] startDictation failed:", e);
      toast.error(`Dictation failed: ${errorMessage.value}`);
      state.value = "error";
      await cleanup();
      state.value = "idle";
    }
  }

  async function stop(): Promise<void> {
    if (state.value !== "listening" && state.value !== "starting") return;
    state.value = "stopping";
    try {
      // Drain captured audio before stopping: offline models decode only on
      // stop, so a chunk lost to the stop-vs-feed race truncates the utterance
      // (drops short ones entirely). flush() resolves once the tail reaches the
      // worker, guaranteeing stop is the last message it sees.
      await capture?.flush().catch(() => {});
      await invoke("speech:stopDictation", { sessionId: SESSION });
    } catch {
      /* the stopped/error event will reset state */
    }
  }

  async function toggle(): Promise<void> {
    if (state.value === "idle") await start();
    else await stop();
  }

  // Push enabled/hotkey/mode to main so the before-input-event handler reflects
  // the latest settings. Call on mount and whenever voice settings change.
  async function syncHotkeyConfig(): Promise<void> {
    const v = settings.value.voice;
    await invoke("speech:setHotkeyConfig", {
      enabled: !!v?.enabled,
      hotkey: v?.hotkey ?? "CommandOrControl+E",
      mode: v?.dictationMode ?? "toggle",
    });
  }

  function wire(): void {
    if (wired) return;
    wired = true;

    listen("ui:dictationKeyDown", () => {
      if (settings.value.voice?.dictationMode === "hold") return;
      void toggle();
    });

    // Hold mode is renderer-owned (main lets the key through so keyup survives).
    window.addEventListener(
      "keydown",
      (e) => {
        const voice = settings.value.voice;
        if (!voice?.enabled || voice.dictationMode !== "hold") return;
        if (matchesHotkey(e, voice.hotkey) && !e.repeat && state.value === "idle") {
          e.preventDefault();
          void start();
        }
      },
      true,
    );
    window.addEventListener(
      "keyup",
      (e) => {
        const voice = settings.value.voice;
        if (!voice?.enabled || voice.dictationMode !== "hold") return;
        if (isHotkeyKeyOrModifier(e, voice.hotkey)) {
          if (state.value === "listening" || state.value === "starting") void stop();
        }
      },
      true,
    );

    listen("speech:ready", () => {
      console.debug("[dictation] speech:ready -> listening");
      ready = true;
      void playListeningSound();
      if (state.value === "starting") state.value = "listening";
    });
    listen<{ text: string }>("speech:partial", (e) => {
      partial.value = e.payload?.text ?? "";
    });
    listen<{ text: string }>("speech:final", (e) => {
      const raw = (e.payload?.text ?? "").trim();
      if (!raw) return;
      const voice = settings.value.voice;
      let text = raw;
      if (voice?.dictionaryEnabled !== false) {
        text = applyDictationDictionary(text, buildDictationRules(voice?.customTerms));
      }
      if (voice?.convertNumbers !== false) {
        text = convertSpokenNumbers(text);
      }
      text = attachSpokenDotToPreviousNumber(text, insertedThisSession);
      if (isDuplicateFinalTranscriptSegment(text, lastFinalText)) return;
      const segment = formatFinalTranscriptSegment(text, insertedThisSession);
      insertText(segment, target);
      insertedThisSession += segment;
      lastFinalText = text;
    });
    listen("speech:stopped", () => {
      console.debug("[dictation] speech:stopped -> idle");
      partial.value = "";
      void cleanup();
      state.value = "idle";
    });
    listen<{ error: string }>("speech:error", (e) => {
      errorMessage.value = e.payload?.error ?? "dictation error";
      console.error("[dictation] speech:error:", errorMessage.value);
      toast.error(`Dictation error: ${errorMessage.value}`);
      partial.value = "";
      void cleanup();
      state.value = "idle";
    });
  }

  return { state, partial, errorMessage, start, stop, toggle, wire, syncHotkeyConfig };
}

async function getListeningSound(): Promise<HTMLAudioElement | null> {
  if (listeningSound) return listeningSound;
  if (!listeningSoundPromise) {
    listeningSoundPromise = invoke<string | null>("get_resource_path", { name: "voice.wav" })
      .then((path) => {
        if (!path) return null;
        listeningSound = new Audio(convertFileSrc(path));
        listeningSound.preload = "auto";
        listeningSound.volume = 0.45;
        return listeningSound;
      })
      .catch((e) => {
        console.warn("[dictation] listening sound unavailable:", e);
        return null;
      });
  }
  return listeningSoundPromise;
}

async function playListeningSound(): Promise<void> {
  const audio = await getListeningSound();
  if (!audio) return;
  // Force a restart every trigger: rapid toggles would otherwise hit a
  // still-playing element and get skipped. pause() aborts any in-flight play()
  // (its promise rejects with AbortError, caught below).
  audio.pause();
  audio.currentTime = 0;
  await audio.play().catch((e) => {
    console.warn("[dictation] listening sound play failed:", e);
  });
}

function modifierWants(accelerator: string): { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string } {
  const parts = accelerator.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const cmdOrCtrl = mods.has("commandorcontrol");
  return {
    meta: (isMac && cmdOrCtrl) || mods.has("cmd") || mods.has("command") || mods.has("meta"),
    ctrl: (!isMac && cmdOrCtrl) || mods.has("ctrl") || mods.has("control"),
    alt: mods.has("alt") || mods.has("option"),
    shift: mods.has("shift"),
    key,
  };
}

function matchesHotkey(e: KeyboardEvent, accelerator: string): boolean {
  const w = modifierWants(accelerator);
  return (
    e.key.toLowerCase() === w.key &&
    e.metaKey === w.meta &&
    e.ctrlKey === w.ctrl &&
    e.altKey === w.alt &&
    e.shiftKey === w.shift
  );
}

// True when the released key is the hotkey's main key or one of its required
// modifier keys — so lifting Cmd (or E) ends a press-and-hold dictation.
function isHotkeyKeyOrModifier(e: KeyboardEvent, accelerator: string): boolean {
  const w = modifierWants(accelerator);
  const k = e.key.toLowerCase();
  if (k === w.key) return true;
  if (k === "meta" && w.meta) return true;
  if (k === "control" && w.ctrl) return true;
  if (k === "alt" && w.alt) return true;
  if (k === "shift" && w.shift) return true;
  return false;
}
