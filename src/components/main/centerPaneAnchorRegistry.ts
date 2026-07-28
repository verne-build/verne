import { readonly, shallowRef, type InjectionKey, type Ref } from "vue";

export interface CenterPaneAnchorRegistry {
  readonly revision: Readonly<Ref<number>>;
  register(anchorId: string, element: HTMLElement): void;
  unregister(anchorId: string, element: HTMLElement): void;
  target(anchorId: string): HTMLElement | null;
  clear(): void;
}

export const centerPaneAnchorRegistryKey: InjectionKey<CenterPaneAnchorRegistry> = Symbol("centerPaneAnchorRegistry");

export function createCenterPaneAnchorRegistry(): CenterPaneAnchorRegistry {
  const targets = new Map<string, HTMLElement>();
  const revision = shallowRef(0);

  return {
    revision: readonly(revision),
    register(anchorId, element) {
      const previous = targets.get(anchorId);
      if (previous === element) return;
      if (import.meta.env.DEV && previous?.isConnected && element.isConnected)
        console.warn(`[center] duplicate connected pane anchor: ${anchorId}`);
      targets.set(anchorId, element);
      revision.value += 1;
    },
    unregister(anchorId, element) {
      if (targets.get(anchorId) !== element) return;
      targets.delete(anchorId);
      revision.value += 1;
    },
    target(anchorId) {
      return targets.get(anchorId) ?? null;
    },
    clear() {
      if (!targets.size) return;
      targets.clear();
      revision.value += 1;
    },
  };
}
