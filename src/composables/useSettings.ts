import { ref, watch } from "vue";
import { invoke, listen } from "@/platform";
import type { AppSettings, LanguageOverrideSettings } from "@/types/shared";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";
import { useRpc } from "./useRpc";
import { readCachedSettings, writeCachedSettings } from "@/lib/bootstrapCache";

// Initial value before load()/cache resolve. Defaults are owned by Electron
// (see @/lib/defaultSettings); clone so reactivity can't mutate the constant.
const settings = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS));
let loaded = false;

// Push the default cursor style to the daemon so it sets the emulator's
// fallback cursor (an app's own DECSCUSR request still wins). Fires on load +
// change; runs before tabs spawn in practice. Fire-and-forget.
watch(
  () => [settings.value.terminalCursorStyle, settings.value.terminalCursorBlink] as const,
  ([shape, blink]) => {
    void invoke("terminal_set_cursor", { shape, blink }).catch(() => {});
  },
  { immediate: true },
);

export function useSettings() {
  async function load() {
    const result = await useRpc().request.getSettings({});
    settings.value = result;
    writeCachedSettings(result);
    loaded = true;
  }

  async function update(partial: Partial<AppSettings>) {
    const next = await useRpc().request.updateSettings({ settings: partial });
    settings.value = next;
    writeCachedSettings(next);
  }

  function listenForChanges() {
    listen("settings-changed", () => load());
  }

  function getSettingForLanguage<K extends keyof LanguageOverrideSettings>(
    key: K,
    languageId: string,
  ): NonNullable<LanguageOverrideSettings[K]> {
    const override = settings.value[`[${languageId}]`] as LanguageOverrideSettings | undefined;
    const val = override?.[key];
    if (val !== undefined && val !== null) return val as NonNullable<LanguageOverrideSettings[K]>;
    return settings.value[key as keyof AppSettings] as NonNullable<LanguageOverrideSettings[K]>;
  }

  return { settings, load, update, listenForChanges, getSettingForLanguage };
}

export function loadCachedSettings(): void {
  const cached = readCachedSettings();
  if (cached && typeof cached === "object" && !Array.isArray(cached)) {
    settings.value = { ...settings.value, ...(cached as Partial<AppSettings>) } as AppSettings;
  }
}
