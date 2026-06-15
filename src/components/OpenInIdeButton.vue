<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ChevronDown, ExternalLink } from "@lucide/vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettings } from "@/composables/useSettings";
import { openInIde, getInstalledIdes } from "@/platform";
import type { ExternalApp } from "@/types/shared";

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

interface IdeMeta {
  label: string;
  icon: string;
  macAppName: string;
}

const IDE_META: Record<ExternalApp, IdeMeta> = {
  cursor: { label: "Cursor", icon: cursorIcon, macAppName: "Cursor" },
  antigravity: { label: "Antigravity", icon: antigravityIcon, macAppName: "Antigravity" },
  windsurf: { label: "Windsurf", icon: windsurfIcon, macAppName: "Windsurf" },
  zed: { label: "Zed", icon: zedIcon, macAppName: "Zed" },
  sublime: { label: "Sublime Text", icon: sublimeIcon, macAppName: "Sublime Text" },
  xcode: { label: "Xcode", icon: xcodeIcon, macAppName: "Xcode" },
  vscode: { label: "VS Code", icon: vscodeIcon, macAppName: "Visual Studio Code" },
  "vscode-insiders": {
    label: "VS Code Insiders",
    icon: vscodeInsidersIcon,
    macAppName: "Visual Studio Code - Insiders",
  },
  intellij: { label: "IntelliJ IDEA", icon: intellijIcon, macAppName: "IntelliJ IDEA" },
  webstorm: { label: "WebStorm", icon: webstormIcon, macAppName: "WebStorm" },
  pycharm: { label: "PyCharm", icon: pycharmIcon, macAppName: "PyCharm" },
  phpstorm: { label: "PhpStorm", icon: phpstormIcon, macAppName: "PhpStorm" },
  rubymine: { label: "RubyMine", icon: rubymineIcon, macAppName: "RubyMine" },
  goland: { label: "GoLand", icon: golandIcon, macAppName: "GoLand" },
  clion: { label: "CLion", icon: clionIcon, macAppName: "CLion" },
  rider: { label: "Rider", icon: riderIcon, macAppName: "Rider" },
  datagrip: { label: "DataGrip", icon: datagripIcon, macAppName: "DataGrip" },
  appcode: { label: "AppCode", icon: appcodeIcon, macAppName: "AppCode" },
  fleet: { label: "Fleet", icon: fleetIcon, macAppName: "Fleet" },
  rustrover: { label: "RustRover", icon: rustroverIcon, macAppName: "RustRover" },
  "android-studio": {
    label: "Android Studio",
    icon: androidStudioIcon,
    macAppName: "Android Studio",
  },
};

const props = defineProps<{ directoryPath: string }>();

const { settings, update } = useSettings();

const dropdownOpen = ref(false);
const installedIdes = ref<Set<string>>(new Set());

onMounted(async () => {
  const ids = await getInstalledIdes();
  installedIdes.value = new Set(ids);
});

const resolvedApp = computed<ExternalApp | null>(() => {
  const dirEditors = settings.value.directoryEditors;
  if (dirEditors && dirEditors[props.directoryPath]) {
    return dirEditors[props.directoryPath] as ExternalApp;
  }
  return (settings.value.defaultEditor as ExternalApp) ?? null;
});

const resolvedMeta = computed(() => (resolvedApp.value ? IDE_META[resolvedApp.value] : null));

const allApps: ExternalApp[] = [
  "cursor",
  "antigravity",
  "windsurf",
  "zed",
  "sublime",
  "xcode",
  "vscode",
  "vscode-insiders",
  "intellij",
  "webstorm",
  "pycharm",
  "phpstorm",
  "rubymine",
  "goland",
  "clion",
  "rider",
  "datagrip",
  "appcode",
  "fleet",
  "rustrover",
  "android-studio",
];

const visibleApps = computed(() =>
  installedIdes.value.size ? allApps.filter((a) => installedIdes.value.has(a)) : allApps,
);

async function openWith(app: ExternalApp) {
  const meta = IDE_META[app];
  try {
    await openInIde(meta.macAppName, props.directoryPath);
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    toast.error(`Failed to open ${meta.label}`, { description });
    return;
  }
  const dirEditors = { ...(settings.value.directoryEditors ?? {}), [props.directoryPath]: app };
  if (!settings.value.defaultEditor) {
    await update({ defaultEditor: app, directoryEditors: dirEditors });
  } else {
    await update({ directoryEditors: dirEditors });
  }
}

function handleMainClick() {
  if (resolvedApp.value) {
    openWith(resolvedApp.value);
  } else {
    dropdownOpen.value = true;
  }
}
</script>

<template>
  <div class="inline-flex items-center">
    <Button
      size="xs"
      variant="outline"
      class="rounded-r-none border-r-0 has-[>img]:px-1.5 has-[>svg]:px-1.5"
      @click="handleMainClick"
    >
      <img
        v-if="resolvedMeta"
        :src="resolvedMeta.icon"
        class="size-4 shrink-0 ring ring-border rounded-xs"
        :alt="resolvedMeta.label"
      />
      <ExternalLink v-else class="size-3 shrink-0" />
    </Button>
    <DropdownMenu v-model:open="dropdownOpen">
      <DropdownMenuTrigger as-child>
        <Button size="xs" variant="outline" class="has-[>svg]:px-1 rounded-l-none">
          <ChevronDown class="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-44" size="sm">
        <DropdownMenuItem
          v-for="app in visibleApps"
          :key="app"
          class="gap-2"
          @click="openWith(app)"
        >
          <img
            :src="IDE_META[app].icon"
            class="size-4 shrink-0 ring ring-border rounded-xs"
            :alt="IDE_META[app].label"
          />
          {{ IDE_META[app].label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
