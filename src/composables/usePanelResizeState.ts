import { nextTick, ref, watch } from "vue";
import { useRpc } from "./useRpc";
import { writeCachedPanelPx } from "@/lib/bootstrapCache";

interface Options {
  cacheKey: "explorer" | "scList" | "commitsList" | "search";
  pxStateKey: string;
  initialPx: number;
  clamp: (px: number) => number;
  visibleStateKey?: string;
  initialVisible?: boolean;
  writeCachedVisible?: (v: boolean) => void;
}

export function usePanelResizeState(opts: Options) {
  const panelRef = ref<any>(null);
  const sizePx = ref(opts.initialPx);
  const visible = ref(opts.initialVisible ?? true);
  let pxTimer: ReturnType<typeof setTimeout> | null = null;
  let visTimer: ReturnType<typeof setTimeout> | null = null;

  function onLayout(sizes: number[]) {
    if (sizes[0] > 0) {
      sizePx.value = sizes[0];
      writeCachedPanelPx(opts.cacheKey, sizes[0]);
      if (pxTimer) clearTimeout(pxTimer);
      pxTimer = setTimeout(() => {
        useRpc().request.setAppState({ key: opts.pxStateKey, value: String(Math.round(sizes[0])) });
      }, 500);
    }
  }

  if (opts.visibleStateKey) {
    watch(visible, (v) => {
      opts.writeCachedVisible?.(v);
      v ? panelRef.value?.expand() : panelRef.value?.collapse();
      if (visTimer) clearTimeout(visTimer);
      visTimer = setTimeout(() => {
        useRpc().request.setAppState({ key: opts.visibleStateKey!, value: v ? "true" : "false" });
      }, 300);
    });
    watch(panelRef, (r) => {
      if (r && !visible.value) nextTick(() => r.collapse());
    });
  }

  function applyPersisted(pxRaw: string | null, visRaw?: string | null) {
    const px = pxRaw !== null && Number.isFinite(parseFloat(pxRaw ?? "")) ? parseFloat(pxRaw!) : null;
    if (px) {
      sizePx.value = opts.clamp(px);
      nextTick(() => panelRef.value?.resize(sizePx.value));
    }
    if (opts.visibleStateKey && visRaw != null) {
      const v = visRaw === "true";
      if (v !== visible.value) visible.value = v;
    }
  }

  function dispose() {
    if (pxTimer) clearTimeout(pxTimer);
    if (visTimer) clearTimeout(visTimer);
  }

  return { panelRef, sizePx, visible, onLayout, applyPersisted, dispose };
}
