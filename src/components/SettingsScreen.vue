<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useSettings } from "@/composables/useSettings";
import { useSettingsNav } from "@/composables/useSettingsNav";
import { useTheme } from "@/composables/useTheme";
import { useRpc } from "@/composables/useRpc";
import { useDirectorySettings } from "@/composables/useDirectorySettings";
import { useWorkspaceStore } from "@/stores/workspace";
import { clearCachedPanelSizes } from "@/lib/bootstrapCache";
import { getInstalledIdes, invoke } from "@/platform";
import { toast } from "vue-sonner";
import type { LanguageOverrideSettings, McpAgentInfo } from "@/types/shared";
import { EXTERNAL_APPS } from "@/types/shared";
import { X, Plus } from "@lucide/vue";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import ThemePreview from "./ThemePreview.vue";
import SettingsMcp from "./SettingsMcp.vue";
import SettingsVoice from "./SettingsVoice.vue";

const emit = defineEmits<{ close: []; fluxCapacitor: [] }>();
const { settings, load, update } = useSettings();
const { darkThemes, themeTitles, setTheme } = useTheme();
const { request } = useRpc();
const { activeCategory } = useSettingsNav();

const ready = ref(false);

// Fire an OS notification (via the native handler, bypassing the focus gate)
// plus a sample in-app toast. The toast carries an action button so the stacked
// layout is visible; the action is a no-op (no real tab to focus).
function sendTestNotification(): void {
  void invoke("notify_test").catch(() => {});
  toast("Verne test notification", {
    description: "Notifications are working.",
    closeButton: true,
    action: { label: "View", onClick: () => {} },
  });
}

const fontWeightOptions = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"];

// IDE
import cursorIcon from "@/assets/app-icons/cursor.svg";
import antigravityIcon from "@/assets/app-icons/antigravity.svg";
import windsurfIcon from "@/assets/app-icons/windsurf.svg";
import zedIcon from "@/assets/app-icons/zed.png";
import sublimeIcon from "@/assets/app-icons/sublime.svg";
import xcodeIcon from "@/assets/app-icons/xcode.svg";
import vscodeIcon from "@/assets/app-icons/vscode.svg";
import vscodeInsidersIcon from "@/assets/app-icons/vscode-insiders.svg";
import intellijIcon from "@/assets/app-icons/intellij.svg";
import webstormIcon from "@/assets/app-icons/webstorm.svg";
import pycharmIcon from "@/assets/app-icons/pycharm.svg";
import phpstormIcon from "@/assets/app-icons/phpstorm.svg";
import rubymineIcon from "@/assets/app-icons/rubymine.svg";
import golandIcon from "@/assets/app-icons/goland.svg";
import clionIcon from "@/assets/app-icons/clion.svg";
import riderIcon from "@/assets/app-icons/rider.svg";
import datagripIcon from "@/assets/app-icons/datagrip.svg";
import appcodeIcon from "@/assets/app-icons/appcode.svg";
import fleetIcon from "@/assets/app-icons/fleet.svg";
import rustroverIcon from "@/assets/app-icons/rustrover.svg";
import androidStudioIcon from "@/assets/app-icons/android-studio.svg";

const IDE_META: Record<string, { label: string; icon: string }> = {
  cursor: { label: "Cursor", icon: cursorIcon },
  antigravity: { label: "Antigravity", icon: antigravityIcon },
  windsurf: { label: "Windsurf", icon: windsurfIcon },
  zed: { label: "Zed", icon: zedIcon },
  sublime: { label: "Sublime Text", icon: sublimeIcon },
  xcode: { label: "Xcode", icon: xcodeIcon },
  vscode: { label: "VS Code", icon: vscodeIcon },
  "vscode-insiders": { label: "VS Code Insiders", icon: vscodeInsidersIcon },
  intellij: { label: "IntelliJ IDEA", icon: intellijIcon },
  webstorm: { label: "WebStorm", icon: webstormIcon },
  pycharm: { label: "PyCharm", icon: pycharmIcon },
  phpstorm: { label: "PhpStorm", icon: phpstormIcon },
  rubymine: { label: "RubyMine", icon: rubymineIcon },
  goland: { label: "GoLand", icon: golandIcon },
  clion: { label: "CLion", icon: clionIcon },
  rider: { label: "Rider", icon: riderIcon },
  datagrip: { label: "DataGrip", icon: datagripIcon },
  appcode: { label: "AppCode", icon: appcodeIcon },
  fleet: { label: "Fleet", icon: fleetIcon },
  rustrover: { label: "RustRover", icon: rustroverIcon },
  "android-studio": { label: "Android Studio", icon: androidStudioIcon },
};
const installedIdes = ref<string[]>([]);
const supportedAgents = ref<McpAgentInfo[]>([]);

// Files exclude
const newPattern = ref("");

// Languages
const supportedLanguages = ["typescript", "javascript", "json", "rust", "python", "go", "html", "css", "vue", "markdown"];
const selectedLang = ref("typescript");
const langOverride = computed(() => {
  const key = `[${selectedLang.value}]` as `[${string}]`;
  return (settings.value[key] as LanguageOverrideSettings | undefined) ?? {};
});

function setLangOverride(field: keyof LanguageOverrideSettings, value: any) {
  const key = `[${selectedLang.value}]` as `[${string}]`;
  const current = (settings.value[key] as LanguageOverrideSettings | undefined) ?? {};
  update({ [key]: { ...current, [field]: value } } as any);
}

function removeLangOverride(field: keyof LanguageOverrideSettings) {
  const key = `[${selectedLang.value}]` as `[${string}]`;
  const current = { ...((settings.value[key] as LanguageOverrideSettings | undefined) ?? {}) };
  delete current[field];
  update({ [key]: current } as any);
}

const langOverrideFields: { key: keyof LanguageOverrideSettings; label: string }[] = [
  { key: "editorTabSize", label: "Tab size" },
  { key: "editorInsertSpaces", label: "Insert spaces" },
  { key: "editorWordWrap", label: "Word wrap" },
];

const availableLangOverrides = computed(() =>
  langOverrideFields.filter((f) => langOverride.value[f.key] === undefined)
);
const activeLangOverrides = computed(() =>
  langOverrideFields.filter((f) => langOverride.value[f.key] !== undefined)
);

// Directories
const store = useWorkspaceStore();
const selectedDirIdForSettings = ref<string | null>(null);
const selectedDirIdRef = computed(() => selectedDirIdForSettings.value);
const { settings: perDirSettings, update: updatePerDirSettings } =
  useDirectorySettings(selectedDirIdRef);
const dirBaseRef = ref("");
watch([perDirSettings, selectedDirIdForSettings], () => {
  dirBaseRef.value = perDirSettings.value.defaultBaseRef ?? "";
});
async function commitDirBaseRef() {
  await updatePerDirSettings({
    defaultBaseRef: dirBaseRef.value.trim() ? dirBaseRef.value.trim() : undefined,
  });
}

const worktreesRootDraft = ref(settings.value.worktreesRoot ?? "");
watch(() => settings.value.worktreesRoot, (v) => {
  worktreesRootDraft.value = v ?? "";
});
async function commitWorktreesRoot() {
  const next = worktreesRootDraft.value.trim();
  await update({ worktreesRoot: next || undefined });
}
async function pickWorktreesRoot() {
  const { path } = await request.pickDirectory({});
  if (path) {
    worktreesRootDraft.value = path;
    await commitWorktreesRoot();
  }
}

// Reset all panel widths to defaults. Sizes live in both localStorage and
// backend app_state and are read on renderer load, so clear both then reload.
const resettingPanels = ref(false);
async function resetPanelSizes() {
  if (resettingPanels.value) return;
  resettingPanels.value = true;
  try {
    clearCachedPanelSizes();
    await Promise.all(
      ["panel_left_px", "panel_right_px", "panel_explorer_px", "panel_sc_list_px", "panel_commits_list_px", "notes_list_px", "search_list_px"]
        .map((key) => request.setAppState({ key, value: null })),
    );
    window.location.reload();
  } catch (e) {
    console.error("[Settings] reset panel sizes failed:", e);
    resettingPanels.value = false;
  }
}

// Helpers

function num(val: string | number, min: number, max: number, cb: (n: number) => void, allowZero = false) {
  const n = Number(val);
  if (allowZero && n === 0) { cb(0); return; }
  if (n >= min && n <= max) cb(n);
}

// Files exclude helpers
function addPattern() {
  const p = newPattern.value.trim();
  if (!p) return;
  const excl = { ...settings.value.filesExclude, [p]: true };
  update({ filesExclude: excl });
  newPattern.value = "";
}

function removePattern(pattern: string) {
  const excl = { ...settings.value.filesExclude };
  delete excl[pattern];
  update({ filesExclude: excl });
}

function togglePattern(pattern: string, val: boolean) {
  const excl = { ...settings.value.filesExclude, [pattern]: val };
  update({ filesExclude: excl });
}

// Escape key
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(async () => {
  await load();
  ready.value = true;
  window.addEventListener("keydown", onKeydown);
  getInstalledIdes().then(ids => { installedIdes.value = ids; });
  request.mcpSupportedAgents({}).then((agents) => { supportedAgents.value = agents; }).catch(() => {});
});
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="h-full bg-[color-mix(in_srgb,var(--sidebar)_65%,var(--editor-bg)_35%)]">
    <ScrollArea v-if="ready" class="h-full">
      <div class="max-w-2xl mx-auto py-8 px-8">

        <!-- Appearance — light theme hidden until light themes ship -->
        <template v-if="activeCategory === 'appearance'">
          <h2 class="text-lg font-semibold mb-6">Appearance</h2>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Theme</div>
                  <div class="text-xs text-muted-foreground">App color theme</div>
                </div>
                <Select :model-value="settings.darkTheme" @update:model-value="(v) => setTheme(String(v))">
                  <SelectTrigger class="w-48 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="t in darkThemes" :key="t" :value="t">{{ themeTitles[t] ?? t }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="px-6 py-4 space-y-2">
                <div class="text-xs text-muted-foreground">Preview</div>
                <ThemePreview />
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Workspace -->
        <template v-if="activeCategory === 'workspace'">
          <h2 class="text-lg font-semibold mb-6">Workspace</h2>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Auto-save</div>
                  <div class="text-xs text-muted-foreground">Automatically save files after changes</div>
                </div>
                <Switch :model-value="settings.autoSave" tabindex="0" @update:model-value="(v: boolean) => update({ autoSave: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Default IDE</div>
                  <div class="text-xs text-muted-foreground">IDE used by the Open button</div>
                </div>
                <Select :model-value="settings.defaultEditor ?? ''" @update:model-value="(v) => update({ defaultEditor: String(v) || undefined })">
                  <SelectTrigger class="w-48 h-8 text-xs" tabindex="0">
                    <SelectValue placeholder="None">
                      <template v-if="settings.defaultEditor && IDE_META[settings.defaultEditor]">
                        <img :src="IDE_META[settings.defaultEditor].icon" class="size-4 shrink-0" />
                        {{ IDE_META[settings.defaultEditor].label }}
                      </template>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="ide in (installedIdes.length ? installedIdes : [...EXTERNAL_APPS])" :key="ide" :value="ide">
                      <img :src="IDE_META[ide]?.icon" class="size-4 shrink-0" /> {{ IDE_META[ide]?.label ?? ide }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Worktrees root folder</div>
                  <div class="text-xs text-muted-foreground">Where new worktrees are created. Defaults to ~/.verne/worktrees/</div>
                </div>
                <div class="flex items-center gap-2">
                  <Input
                    v-model="worktreesRootDraft"
                    placeholder="~/.verne/worktrees"
                    class="w-48 h-8 text-xs"
                    tabindex="0"
                    @blur="commitWorktreesRoot"
                    @keydown.enter="commitWorktreesRoot"
                  />
                  <Button variant="outline" size="sm" tabindex="0" @click="pickWorktreesRoot">Browse…</Button>
                </div>
              </div>
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Reset panel sizes</div>
                  <div class="text-xs text-muted-foreground">Restore sidebars and panels to their default widths (reloads the window)</div>
                </div>
                <Button variant="outline" size="sm" tabindex="0" :disabled="resettingPanels" @click="resetPanelSizes">Reset</Button>
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Notifications -->
        <template v-if="activeCategory === 'notifications'">
          <h2 class="text-lg font-semibold mb-6">Notifications</h2>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Mute notifications while focused</div>
                  <div class="text-xs text-muted-foreground">Suppress OS notifications when Verne is the active window</div>
                </div>
                <Switch :model-value="settings.notificationsFocusGate" tabindex="0" @update:model-value="(v: boolean) => update({ notificationsFocusGate: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">In-app agent alerts</div>
                  <div class="text-xs text-muted-foreground">Show a toast when an agent needs attention while Verne is focused</div>
                </div>
                <Switch :model-value="settings.notificationsInApp" tabindex="0" @update:model-value="(v: boolean) => update({ notificationsInApp: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Play notification sound</div>
                  <div class="text-xs text-muted-foreground">Play a sound with notifications</div>
                </div>
                <Switch :model-value="settings.notificationsSound" tabindex="0" @update:model-value="(v: boolean) => update({ notificationsSound: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Send test notification</div>
                  <div class="text-xs text-muted-foreground">Fire an OS notification and an in-app toast to check they work</div>
                </div>
                <Button variant="outline" size="sm" tabindex="0" @click="sendTestNotification">Send Test</Button>
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Editor -->
        <template v-if="activeCategory === 'editor'">
          <h2 class="text-lg font-semibold mb-6">Editor</h2>

          <!-- LSP -->
          <Card class="!py-0 !gap-0 bg-popover mb-6">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Language server</div>
                  <div class="text-xs text-muted-foreground">Enable LSP for hover, completions, diagnostics</div>
                </div>
                <Switch :model-value="settings.lspEnabled" tabindex="0" @update:model-value="(v: boolean) => update({ lspEnabled: v })" />
              </div>
            </CardContent>
          </Card>

          <!-- Font -->
          <h3 class="text-sm font-bold mb-2">Font</h3>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Font family</div>
                  <div class="text-xs text-muted-foreground">Editor font family</div>
                </div>
                <Input :model-value="settings.editorFontFamily" class="w-64 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => { const s = String(v).trim(); if (s) update({ editorFontFamily: s }) }" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Font size</div>
                  <div class="text-xs text-muted-foreground">Editor font size in pixels</div>
                </div>
                <Input type="number" :model-value="settings.editorFontSize" :min="8" :max="32" class="w-24 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => num(v, 8, 32, n => update({ editorFontSize: n }))" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Font weight</div>
                  <div class="text-xs text-muted-foreground">Editor font weight</div>
                </div>
                <Select :model-value="settings.editorFontWeight" @update:model-value="(v) => update({ editorFontWeight: String(v) })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="w in fontWeightOptions" :key="w" :value="w">{{ w }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Line height</div>
                  <div class="text-xs text-muted-foreground">Line height (0 for auto)</div>
                </div>
                <Input type="number" :model-value="settings.editorLineHeight" :min="0" :max="64" class="w-24 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => num(v, 8, 64, n => update({ editorLineHeight: n }), true)" />
              </div>
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Font ligatures</div>
                  <div class="text-xs text-muted-foreground">Enable font ligatures</div>
                </div>
                <Switch :model-value="settings.editorFontLigatures" tabindex="0"
                  @update:model-value="(v: boolean) => update({ editorFontLigatures: v })" />
              </div>
            </CardContent>
          </Card>

          <!-- Behavior -->
          <h3 class="text-sm font-bold mt-6 mb-2">Behavior</h3>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Tab size</div>
                  <div class="text-xs text-muted-foreground">Number of spaces per tab</div>
                </div>
                <Input type="number" :model-value="settings.editorTabSize" :min="1" :max="8" class="w-24 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => num(v, 1, 8, n => update({ editorTabSize: n }))" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Insert spaces</div>
                  <div class="text-xs text-muted-foreground">Use spaces instead of tabs</div>
                </div>
                <Switch :model-value="settings.editorInsertSpaces" tabindex="0" @update:model-value="(v: boolean) => update({ editorInsertSpaces: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Word wrap</div>
                  <div class="text-xs text-muted-foreground">Wrap long lines</div>
                </div>
                <Switch :model-value="settings.editorWordWrap" tabindex="0" @update:model-value="(v: boolean) => update({ editorWordWrap: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Line numbers</div>
                  <div class="text-xs text-muted-foreground">Show line numbers in the gutter</div>
                </div>
                <Switch :model-value="settings.editorLineNumbers" tabindex="0" @update:model-value="(v: boolean) => update({ editorLineNumbers: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Sticky scroll</div>
                  <div class="text-xs text-muted-foreground">Pin scope headers while scrolling</div>
                </div>
                <Switch :model-value="settings.editorStickyScroll" tabindex="0" @update:model-value="(v: boolean) => update({ editorStickyScroll: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Multi-cursor modifier</div>
                  <div class="text-xs text-muted-foreground">Modifier for adding cursors</div>
                </div>
                <Select :model-value="settings.editorMultiCursorModifier" @update:model-value="(v) => update({ editorMultiCursorModifier: String(v) as 'alt' | 'ctrlCmd' })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alt">Alt</SelectItem>
                    <SelectItem value="ctrlCmd">Ctrl/Cmd</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <!-- Minimap -->
          <h3 class="text-sm font-bold mt-6 mb-2">Minimap</h3>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Show minimap</div>
                  <div class="text-xs text-muted-foreground">Show code minimap</div>
                </div>
                <Switch :model-value="settings.editorMinimap" tabindex="0" @update:model-value="(v: boolean) => update({ editorMinimap: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Render characters</div>
                  <div class="text-xs text-muted-foreground">Render actual characters instead of blocks</div>
                </div>
                <Switch :model-value="settings.editorMinimapRenderCharacters" tabindex="0" @update:model-value="(v: boolean) => update({ editorMinimapRenderCharacters: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Scale</div>
                  <div class="text-xs text-muted-foreground">Minimap scale factor</div>
                </div>
                <Input type="number" :model-value="settings.editorMinimapScale" :min="1" :max="3" class="w-24 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => num(v, 1, 3, n => update({ editorMinimapScale: n }))" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Show slider</div>
                  <div class="text-xs text-muted-foreground">When to show the minimap slider</div>
                </div>
                <Select :model-value="settings.editorMinimapShowSlider" @update:model-value="(v) => update({ editorMinimapShowSlider: String(v) as 'always' | 'mouseover' })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">Always</SelectItem>
                    <SelectItem value="mouseover">Mouseover</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Autohide</div>
                  <div class="text-xs text-muted-foreground">Hide minimap when not scrolling</div>
                </div>
                <Switch :model-value="settings.editorMinimapAutohide" tabindex="0" @update:model-value="(v: boolean) => update({ editorMinimapAutohide: v })" />
              </div>
            </CardContent>
          </Card>

          <!-- Markdown -->
          <h3 class="text-sm font-bold mt-6 mb-2">Markdown</h3>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Default view</div>
                  <div class="text-xs text-muted-foreground">How markdown files open by default</div>
                </div>
                <Select :model-value="settings.markdownDefaultView ?? 'preview'" @update:model-value="(v) => update({ markdownDefaultView: String(v) as 'preview' | 'edit' })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preview">Preview</SelectItem>
                    <SelectItem value="edit">Edit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Terminal -->
        <template v-if="activeCategory === 'terminal'">
          <h2 class="text-lg font-semibold mb-6">Terminal</h2>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Font family</div>
                  <div class="text-xs text-muted-foreground">Terminal font family</div>
                </div>
                <Input :model-value="settings.terminalFontFamily" class="w-64 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => { const s = String(v).trim(); if (s) update({ terminalFontFamily: s }) }" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Font size</div>
                  <div class="text-xs text-muted-foreground">Terminal font size in pixels</div>
                </div>
                <Input type="number" :model-value="settings.terminalFontSize" :min="8" :max="32" class="w-24 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => num(v, 8, 32, n => update({ terminalFontSize: n }))" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Font weight</div>
                  <div class="text-xs text-muted-foreground">Terminal font weight</div>
                </div>
                <Select :model-value="settings.terminalFontWeight" @update:model-value="(v) => update({ terminalFontWeight: String(v) })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="w in fontWeightOptions" :key="w" :value="w">{{ w }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Bold font weight</div>
                  <div class="text-xs text-muted-foreground">Font weight for bold text</div>
                </div>
                <Select :model-value="settings.terminalFontWeightBold" @update:model-value="(v) => update({ terminalFontWeightBold: String(v) })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="w in fontWeightOptions" :key="w" :value="w">{{ w }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Line height</div>
                  <div class="text-xs text-muted-foreground">Terminal line height multiplier</div>
                </div>
                <Input type="number" :model-value="settings.terminalLineHeight" :min="0.5" :max="3" :step="0.1" class="w-24 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => { const n = Number(v); if (n >= 0.5 && n <= 3) update({ terminalLineHeight: n }) }" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Padding</div>
                  <div class="text-xs text-muted-foreground">Inner padding around the terminal grid (px)</div>
                </div>
                <Input type="number" :model-value="settings.terminalPadding" :min="0" :max="40" class="w-24 h-8 text-xs" tabindex="0"
                  @update:model-value="(v: string | number) => num(v, 0, 40, n => update({ terminalPadding: n }))" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Font ligatures</div>
                  <div class="text-xs text-muted-foreground">Enable font ligatures</div>
                </div>
                <Switch :model-value="settings.terminalFontLigatures" tabindex="0" @update:model-value="(v: boolean) => update({ terminalFontLigatures: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Cursor style</div>
                  <div class="text-xs text-muted-foreground">Default cursor shape (programs can still override it)</div>
                </div>
                <Select :model-value="settings.terminalCursorStyle" @update:model-value="(v) => update({ terminalCursorStyle: String(v) as 'block' | 'beam' | 'underline' })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="block">Block</SelectItem>
                    <SelectItem value="beam">Beam</SelectItem>
                    <SelectItem value="underline">Underline</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Cursor blink</div>
                  <div class="text-xs text-muted-foreground">Blink the cursor</div>
                </div>
                <Switch :model-value="settings.terminalCursorBlink" tabindex="0" @update:model-value="(v: boolean) => update({ terminalCursorBlink: v })" />
              </div>
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Renderer</div>
                  <div class="text-xs text-muted-foreground">WebGL is GPU-accelerated, Canvas is the compatibility fallback</div>
                </div>
                <Select :model-value="settings.terminalRenderer" @update:model-value="(v) => update({ terminalRenderer: String(v) as 'webgl' | 'canvas' })">
                  <SelectTrigger class="w-32 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webgl">WebGL</SelectItem>
                    <SelectItem value="canvas">Canvas</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Files -->
        <template v-if="activeCategory === 'files'">
          <h2 class="text-lg font-semibold mb-6">Files Exclude</h2>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div v-for="(enabled, pattern) in settings.filesExclude" :key="pattern"
                class="flex items-center justify-between px-6 py-3 border-b border-border">
                <code class="text-xs font-mono">{{ pattern }}</code>
                <div class="flex items-center gap-2">
                  <Switch :model-value="enabled" tabindex="0" @update:model-value="(v: boolean) => togglePattern(String(pattern), v)" />
                  <Button size="icon-xs" variant="ghost" tabindex="0" @click="removePattern(String(pattern))">
                    <X class="size-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </div>
              <div class="flex items-center gap-2 px-6 py-4">
                <Input v-model="newPattern" placeholder="**/node_modules" class="h-8 text-xs font-mono flex-1" tabindex="0"
                  @keydown.enter="addPattern" />
                <Button size="sm" class="h-8 text-xs" tabindex="0" @click="addPattern">
                  <Plus class="size-3.5 mr-1" />
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Directories -->
        <template v-if="activeCategory === 'directories'">
          <h2 class="text-lg font-semibold mb-6">Directories</h2>
          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                <div>
                  <div class="text-sm font-medium">Directory</div>
                  <div class="text-xs text-muted-foreground">Pick a directory to configure</div>
                </div>
                <Select :model-value="selectedDirIdForSettings ?? ''" @update:model-value="(v) => (selectedDirIdForSettings = String(v) || null)">
                  <SelectTrigger class="w-64 h-8 text-xs" tabindex="0"><SelectValue placeholder="Select a directory…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="d in store.directories" :key="d.id" :value="d.id">{{ d.name }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-if="selectedDirIdForSettings" class="px-6 py-4">
                <div class="text-sm font-medium mb-1">Default base ref for new worktrees</div>
                <Input
                  v-model="dirBaseRef"
                  placeholder="origin/main"
                  class="h-8 text-xs"
                  tabindex="0"
                  @blur="commitDirBaseRef"
                  @keydown.enter="commitDirBaseRef"
                />
                <div class="mt-1 text-xs text-muted-foreground">
                  Used when creating a worktree-backed agent. Empty = use directory HEAD.
                </div>
              </div>
              <div v-else class="px-6 py-4 text-xs text-muted-foreground">
                Select a directory above to configure its settings.
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Languages -->
        <template v-if="activeCategory === 'languages'">
          <h2 class="text-lg font-semibold mb-6">Language Overrides</h2>

          <div class="mb-6">
            <Select :model-value="selectedLang" @update:model-value="(v) => selectedLang = String(v)">
              <SelectTrigger class="w-48 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="l in supportedLanguages" :key="l" :value="l">{{ l }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card class="!py-0 !gap-0 bg-popover">
            <CardContent class="!p-0">
              <!-- Active overrides -->
              <template v-for="field in activeLangOverrides" :key="field.key">
                <div class="flex items-center justify-between px-6 py-4 border-b border-border">
                  <div class="text-sm font-medium">{{ field.label }}</div>
                  <div class="flex items-center gap-2">
                    <!-- Boolean switch -->
                    <template v-if="field.key === 'editorInsertSpaces' || field.key === 'editorWordWrap'">
                      <Switch :model-value="!!langOverride[field.key]" tabindex="0" @update:model-value="(v: boolean) => setLangOverride(field.key, v)" />
                    </template>
                    <!-- Number -->
                    <template v-else-if="field.key === 'editorTabSize'">
                      <Input type="number" :model-value="langOverride[field.key]" :min="1" :max="8" class="w-24 h-8 text-xs" tabindex="0"
                        @update:model-value="(v: string | number) => num(v, 1, 8, n => setLangOverride('editorTabSize', n))" />
                    </template>
                    <Button size="icon-xs" variant="ghost" tabindex="0" @click="removeLangOverride(field.key)">
                      <X class="size-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </template>

              <!-- Add override -->
              <div v-if="availableLangOverrides.length" class="px-6 py-4">
                <Select @update:model-value="(v) => { const key = String(v) as keyof LanguageOverrideSettings; setLangOverride(key, key === 'editorTabSize' ? 2 : false) }">
                  <SelectTrigger class="w-48 h-8 text-xs" tabindex="0">
                    <span class="text-muted-foreground">Add override...</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="f in availableLangOverrides" :key="f.key" :value="f.key">{{ f.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <!-- Empty state -->
              <div v-if="!activeLangOverrides.length && !availableLangOverrides.length" class="px-6 py-4 text-xs text-muted-foreground">
                No overrides available
              </div>
            </CardContent>
          </Card>
        </template>

        <template v-if="activeCategory === 'voice'">
          <SettingsVoice />
        </template>
        <template v-if="activeCategory === 'mcp'">
          <h2 class="text-lg font-semibold mb-6">Agents</h2>
          <Card class="!py-0 !gap-0 bg-popover mb-6">
            <CardContent class="!p-0">
              <div class="flex items-center justify-between px-6 py-4">
                <div>
                  <div class="text-sm font-medium">Review Agent</div>
                  <div class="text-xs text-muted-foreground">Agent used when sending a diff review</div>
                </div>
                <Select :model-value="settings.reviewAgent" @update:model-value="(v) => update({ reviewAgent: String(v) })">
                  <SelectTrigger class="w-48 h-8 text-xs" tabindex="0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="agent in supportedAgents" :key="agent.key" :value="agent.key">
                      {{ agent.displayName }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
          <SettingsMcp />
        </template>
      </div>
    </ScrollArea>
  </div>
</template>
