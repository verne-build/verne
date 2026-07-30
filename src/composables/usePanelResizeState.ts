import { computed, nextTick, ref, watch, type Ref } from "vue";
import { useRpc } from "./useRpc";
import { writeCachedPanelPx } from "@/lib/bootstrapCache";
import { nextOverlayMode } from "@/lib/overlaySidebar";

interface Options {
  cacheKey: "explorer" | "scList" | "commitsList" | "search";
  pxStateKey: string;
  initialPx: number;
  clamp: (px: number) => number;
  visibleStateKey?: string;
  initialVisible?: boolean;
  writeCachedVisible?: (v: boolean) => void;
  /** Live width of the containing right panel. Omit to stay always-docked. */
  containerWidth?: Ref<number>;
}

export function usePanelResizeState(opts: Options) {
  const panelRef = ref<any>(null);
  const sizePx = ref(opts.initialPx);
  const visible = ref(opts.initialVisible ?? true);
  // Narrow panel: the sidebar floats over the content instead of splitting it.
  const overlayMode = ref(false);
  // Transient — an overlay peek is never persisted, so widening the panel
  // restores whatever `visible` held before the squeeze.
  const overlayOpen = ref(false);
  let pxTimer: ReturnType<typeof setTimeout> | null = null;
  let visTimer: ReturnType<typeof setTimeout> | null = null;

  function onLayout(sizes: number[]) {
    // Overlaid: reka's flex values no longer describe what's on screen, so
    // persisting them would clobber the remembered docked width.
    if (overlayMode.value) return;
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
      if (!overlayMode.value) v ? panelRef.value?.expand() : panelRef.value?.collapse();
      if (visTimer) clearTimeout(visTimer);
      visTimer = setTimeout(() => {
        useRpc().request.setAppState({ key: opts.visibleStateKey!, value: v ? "true" : "false" });
      }, 300);
    });
    watch(panelRef, (r) => {
      if (r && !visible.value && !overlayMode.value) nextTick(() => r.collapse());
    });
  }

  if (opts.containerWidth) {
    const width = opts.containerWidth;
    watch([width, sizePx], () => {
      const next = nextOverlayMode(overlayMode.value, width.value, sizePx.value);
      if (next === overlayMode.value) return;
      overlayMode.value = next;
      if (next) {
        // Entering: auto-collapse. Expand the reka panel so it isn't stuck at
        // flex-basis 0 — while overlaid its width comes from CSS, and the
        // closed state is a transform, not a collapse.
        overlayOpen.value = false;
        nextTick(() => panelRef.value?.expand());
      } else {
        // Leaving: `visible` still holds the docked choice, so re-apply it.
        nextTick(() => (visible.value ? panelRef.value?.expand() : panelRef.value?.collapse()));
      }
    }, { immediate: true });
  }

  /** One binding for the toggle button in both modes. */
  const open = computed({
    get: () => (overlayMode.value ? overlayOpen.value : visible.value),
    set: (v: boolean) => {
      if (overlayMode.value) overlayOpen.value = v;
      else visible.value = v;
    },
  });

  /** Close an open overlay — scrim click, Esc, or picking an item. No-op when docked. */
  function dismissOverlay() {
    if (overlayMode.value) overlayOpen.value = false;
  }

  function applyPersisted(pxRaw: string | null, visRaw?: string | null) {
    const px = pxRaw !== null && Number.isFinite(parseFloat(pxRaw ?? "")) ? parseFloat(pxRaw!) : null;
    if (px) {
      sizePx.value = opts.clamp(px);
      if (!overlayMode.value) nextTick(() => panelRef.value?.resize(sizePx.value));
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

  return {
    panelRef, sizePx, visible, overlayMode, overlayOpen, open,
    onLayout, dismissOverlay, applyPersisted, dispose,
  };
}

export type PanelResizeState = ReturnType<typeof usePanelResizeState>;
