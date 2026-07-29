import { readonly, shallowRef, type InjectionKey, type Ref } from "vue";

export interface CenterPaneAnchorRegistry {
  readonly revision: Readonly<Ref<number>>;
  register(anchorId: string, element: HTMLElement): void;
  unregister(anchorId: string, element: HTMLElement): void;
  target(anchorId: string): HTMLElement | null;
  restoreCapturedFocus(anchorId: string): void;
  clear(): void;
}

export const centerPaneAnchorRegistryKey: InjectionKey<CenterPaneAnchorRegistry> = Symbol("centerPaneAnchorRegistry");

export function createCenterPaneAnchorRegistry(): CenterPaneAnchorRegistry {
  const targets = new Map<string, HTMLElement>();
  const capturedFocus = new Map<string, HTMLElement>();
  const focusHandoffs = new Map<string, HTMLElement>();
  const revision = shallowRef(0);

  return {
    revision: readonly(revision),
    register(anchorId, element) {
      const previous = targets.get(anchorId);
      if (previous === element) return;
      const handoff = focusHandoffs.get(anchorId);
      focusHandoffs.delete(anchorId);
      const activeElement = document.activeElement;
      if (previous && activeElement instanceof HTMLElement && previous.contains(activeElement))
        capturedFocus.set(anchorId, activeElement);
      else if (handoff) capturedFocus.set(anchorId, handoff);
      if (import.meta.env.DEV && previous?.isConnected && element.isConnected)
        console.warn(`[center] duplicate connected pane anchor: ${anchorId}`);
      targets.set(anchorId, element);
      revision.value += 1;
    },
    unregister(anchorId, element) {
      if (targets.get(anchorId) !== element) return;
      const activeElement = document.activeElement;
      targets.delete(anchorId);
      capturedFocus.delete(anchorId);
      focusHandoffs.delete(anchorId);
      if (activeElement instanceof HTMLElement && element.contains(activeElement)) {
        focusHandoffs.set(anchorId, activeElement);
        // Vue unregisters then registers a replacement in the same turn.
        queueMicrotask(() => {
          if (focusHandoffs.get(anchorId) === activeElement)
            focusHandoffs.delete(anchorId);
        });
      }
      revision.value += 1;
    },
    target(anchorId) {
      return targets.get(anchorId) ?? null;
    },
    restoreCapturedFocus(anchorId) {
      const element = capturedFocus.get(anchorId);
      capturedFocus.delete(anchorId);
      if (!element?.isConnected) return;
      const activeElement = document.activeElement;
      if (activeElement && activeElement !== document.body && activeElement !== document.documentElement)
        return;
      element.focus({ preventScroll: true });
    },
    clear() {
      if (!targets.size && !capturedFocus.size && !focusHandoffs.size) return;
      const hadTargets = targets.size > 0;
      targets.clear();
      capturedFocus.clear();
      focusHandoffs.clear();
      if (hadTargets) revision.value += 1;
    },
  };
}
