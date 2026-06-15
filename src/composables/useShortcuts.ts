// src/composables/useShortcuts.ts
// Reactive keyboard-shortcut registry. Singleton module state (like useSettings)
// so App.vue and the modal share one registry that updates live on
// `shortcuts-changed`.
import { ref } from "vue";
import { listen } from "@/platform";
import { useRpc } from "./useRpc";
import { matchesEvent, toDisplayKeys } from "@/lib/shortcuts/binding";
import { SHORTCUT_CATALOG } from "@/lib/shortcuts/catalog";
import type { Shortcut } from "@/lib/shortcuts/types";

// Seed synchronously from the in-code catalog so keydown matching works from the
// very first event — before the async get_shortcuts round-trip resolves. load()
// then overlays any user overrides from the registry file.
const registry = ref<Shortcut[]>(
  SHORTCUT_CATALOG.map((d) => ({
    name: d.name,
    label: d.label,
    category: d.category,
    target: d.target,
    binding: d.defaultBinding,
  })),
);
let loaded = false;

export function useShortcuts() {
  async function load() {
    registry.value = await useRpc().request.getShortcuts({});
    loaded = true;
  }

  function listenForChanges() {
    void listen("shortcuts-changed", () => { void load(); });
  }

  function bindingOf(name: string): string | undefined {
    return registry.value.find((s) => s.name === name)?.binding;
  }

  function matches(name: string, e: KeyboardEvent): boolean {
    const b = bindingOf(name);
    return b ? matchesEvent(b, e) : false;
  }

  function displayKeys(name: string): string[] {
    const b = bindingOf(name);
    return b ? toDisplayKeys(b) : [];
  }

  return {
    registry,
    load,
    listenForChanges,
    bindingOf,
    matches,
    displayKeys,
    get loaded() { return loaded; },
  };
}
