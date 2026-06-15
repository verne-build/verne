import { ref } from "vue";
import { invoke } from "@/platform";

// Hidden dev FPS meter (toggle: ⌘⌃⇧F). Ships in prod but no UI surface.
// rAF loop runs ONLY while visible — zero cost when off.
const visible = ref(false);
const fps = ref(0);
// Max refresh (Hz) of the window's current screen. If fps << maxFps → WKWebView cap;
// if fps ≈ maxFps === 60 on a 120Hz panel → macOS negotiated the display at 60.
const maxFps = ref(0);
let rafId: number | null = null;
let last = 0;
let acc = 0;
let frames = 0;

function loop(t: number) {
  if (last) { acc += t - last; frames++; }
  last = t;
  if (acc >= 250) { fps.value = Math.round(1000 / (acc / frames)); acc = 0; frames = 0; }
  rafId = requestAnimationFrame(loop);
}

function start() {
  if (rafId != null) return;
  last = 0; acc = 0; frames = 0;
  invoke<number>("get_window_max_fps").then((v) => { maxFps.value = v; }).catch(() => { maxFps.value = 0; });
  rafId = requestAnimationFrame(loop);
}

function stop() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  fps.value = 0;
}

export function useFpsMeter() {
  function toggle() {
    visible.value = !visible.value;
    if (visible.value) start(); else stop();
  }
  return { fpsVisible: visible, fps, maxFps, toggle };
}
