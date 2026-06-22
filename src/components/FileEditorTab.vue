<script setup lang="ts">
import { ref, computed, watch, onActivated, nextTick } from "vue";
import type { FilePanelTab, FilePanelFileTab } from "@/types";
import { useSettings } from "@/composables/useSettings";
import { PANEL_SIZES } from "@/lib/panelSizes";
import { addToAgent } from "@/composables/useAddToAgent";
import { convertFileSrc } from "@/platform";
import { toast } from "vue-sonner";
import CodeEditor from "./CodeEditor.vue";
import FilesPanel from "./FilesPanel.vue";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./ui/resizable";
import { Button } from "./ui/button";
import SegmentedTabs, { type SegmentedOption } from "./SegmentedTabs.vue";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./ui/dropdown-menu";
import { Switch } from "./ui/switch";
import PanelLeftFilled from "./icons/PanelLeftFilled.vue";
import {
  ChevronRight,
  AlertTriangle,
  PanelLeft,
  Files,
  MoreHorizontal,
  Check,
  PenLine,
  Eye,
} from "@lucide/vue";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";

const props = defineProps<{
  activeTab: FilePanelTab | null;
  rootDir: string | undefined;
  explorerVisible: boolean;
  explorerSizePx: number;
  activeFilePath: string | null;
}>();

const emit = defineEmits<{
  "update:explorerVisible": [v: boolean];
  "register-panel-ref": [el: any];
  "explorer-layout": [sizes: number[]];
  "explorer-collapse": [];
  "open-file": [path: string, permanent: boolean];
  "close-tab": [id: string];
  dirty: [path: string, d: boolean];
  "view-state": [id: string, s: any];
  "open-file-search": [];
  "new-file": [];
  dragging: [v: boolean];
}>();

const LIST_PANEL_MIN_PX = PANEL_SIZES.list.min;
const LIST_PANEL_MAX_PX = PANEL_SIZES.list.max;

const { settings, update: updateSettings } = useSettings();
const markdownDefaultView = computed(() => settings.value.markdownDefaultView ?? "preview");

// Reactivated from KeepAlive (returning from a non-file tab): the DOM was detached
// while cached, so nudge Monaco to relayout once it's reattached and sized.
onActivated(() => {
  nextTick(() => window.dispatchEvent(new CustomEvent("relayout-editors")));
});

function defaultPreviewFor(ext: string | null | undefined): boolean {
  if (ext === "md") return markdownDefaultView.value !== "edit";
  return false;
}

const filePreview = ref(false);
watch(() => props.activeTab, (tab) => {
  const ext = tab?.kind === "file" ? tab.filePath.split(".").pop()?.toLowerCase() : null;
  filePreview.value = defaultPreviewFor(ext);
}, { immediate: true });

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "avif"]);
function isImageFile(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

const activeFileIsImage = computed(() => {
  const t = props.activeTab;
  return t?.kind === "file" && isImageFile(t.filePath);
});
const activeImageSrc = computed(() => {
  const t = props.activeTab;
  return activeFileIsImage.value && t?.kind === "file" ? convertFileSrc(t.filePath) : "";
});
const imageLoadError = ref(false);
watch(() => props.activeTab, () => { imageLoadError.value = false; });

const breadcrumbSegments = computed(() => {
  const t = props.activeTab;
  if (!t || t.kind !== "file") return null;
  const root = props.rootDir;
  const rel = root && t.filePath.startsWith(root)
    ? t.filePath.slice(root.length + 1)
    : t.filePath.replace(/^\/Users\/[^/]+/, "~");
  return rel.split("/");
});

const activeFileExt = computed(() => {
  const t = props.activeTab;
  if (t?.kind !== "file") return null;
  return t.filePath.split(".").pop()?.toLowerCase() ?? null;
});

const activeFileHasPreview = computed(
  () => activeFileExt.value === "md" || activeFileExt.value === "svg",
);

const previewTabOptions: SegmentedOption[] = [
  { value: "edit", label: "Edit", icon: PenLine },
  { value: "preview", label: "Preview", icon: Eye },
];

const LSP_EXTS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue"]);
const activeFileHasLsp = computed(
  () => !!props.rootDir && LSP_EXTS.has(activeFileExt.value ?? ""),
);

const activeRelativePath = computed(() => {
  const abs = props.activeFilePath;
  if (!abs) return null;
  const root = props.rootDir;
  return root && abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
});

function addActiveToAgent() {
  if (props.activeFilePath) void addToAgent(props.activeFilePath);
}

async function copyActivePath(relative: boolean) {
  const text = relative ? activeRelativePath.value : props.activeFilePath;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(relative ? "Copied relative path" : "Copied path");
  } catch (e) {
    toast.error(String(e));
  }
}

function activeTabAsFile(): FilePanelFileTab | null {
  const t = props.activeTab;
  return t?.kind === "file" ? t : null;
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden flex-1 min-h-0">
    <div
      class="flex items-center justify-between px-2 h-8 text-xs text-muted-foreground bg-sidebar border-b border-border overflow-hidden shrink-0"
    >
      <div class="flex items-center gap-1 min-w-0">
        <Button
          size="icon-xs"
          variant="ghost"
          class="text-muted-foreground shrink-0"
          tabindex="0"
          @click="emit('update:explorerVisible', !explorerVisible)"
        >
          <PanelLeft v-if="!explorerVisible" class="size-3.5" />
          <PanelLeftFilled v-else class="size-3.5" />
        </Button>
        <template v-for="(seg, i) in breadcrumbSegments ?? []" :key="i">
          <ChevronRight v-if="i > 0" class="size-3 shrink-0 opacity-50" />
          <span :class="i === (breadcrumbSegments?.length ?? 0) - 1 ? 'text-foreground truncate' : 'shrink-0'">{{ seg }}</span>
        </template>
      </div>
      <div id="editor-toolbar" class="flex items-center shrink-0 ml-3 gap-0.5">
        <template v-if="activeFileHasPreview">
          <SegmentedTabs
            :model-value="filePreview ? 'preview' : 'edit'"
            :options="previewTabOptions"
            @update:model-value="(v) => filePreview = v === 'preview'"
          />
        </template>
        <DropdownMenu v-if="activeTab?.kind === 'file'">
          <DropdownMenuTrigger as-child>
            <button
              class="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="More options"
            ><MoreHorizontal class="size-3.5" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" size="sm" class="min-w-44">
            <DropdownMenuItem @select="addActiveToAgent">Add to Agent</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="copyActivePath(false)">Copy Path</DropdownMenuItem>
            <DropdownMenuItem @select="copyActivePath(true)">Copy Relative Path</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              class="justify-between"
              @select.prevent="updateSettings({ editorWordWrap: !settings.editorWordWrap })"
            >
              <span>Word Wrap</span>
              <Switch
                :model-value="settings.editorWordWrap"
                class="ml-2 scale-75 origin-right"
                @update:model-value="(v: boolean) => updateSettings({ editorWordWrap: v })"
                @click.stop
              />
            </DropdownMenuItem>
            <DropdownMenuItem
              class="justify-between"
              @select.prevent="updateSettings({ editorLineNumbers: !settings.editorLineNumbers })"
            >
              <span>Line Numbers</span>
              <Switch
                :model-value="settings.editorLineNumbers"
                class="ml-2 scale-75 origin-right"
                @update:model-value="(v: boolean) => updateSettings({ editorLineNumbers: v })"
                @click.stop
              />
            </DropdownMenuItem>
            <DropdownMenuItem
              class="justify-between"
              @select.prevent="updateSettings({ editorMinimap: !settings.editorMinimap })"
            >
              <span>Minimap</span>
              <Switch
                :model-value="settings.editorMinimap"
                class="ml-2 scale-75 origin-right"
                @update:model-value="(v: boolean) => updateSettings({ editorMinimap: v })"
                @click.stop
              />
            </DropdownMenuItem>
            <DropdownMenuSeparator v-if="activeFileHasLsp" />
            <DropdownMenuItem
              v-if="activeFileHasLsp"
              class="justify-between"
              @select.prevent="updateSettings({ lspEnabled: !settings.lspEnabled })"
            >
              <span>Language Server</span>
              <Switch
                :model-value="settings.lspEnabled"
                class="ml-2 scale-75 origin-right"
                @update:model-value="(v: boolean) => updateSettings({ lspEnabled: v })"
                @click.stop
              />
            </DropdownMenuItem>
            <template v-if="activeFileExt === 'md'">
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger class="text-xs">Default View</DropdownMenuSubTrigger>
                <DropdownMenuSubContent class="min-w-32">
                  <DropdownMenuItem @select="updateSettings({ markdownDefaultView: 'edit' })">
                    <Check :class="['size-3.5', markdownDefaultView === 'edit' ? 'opacity-100' : 'opacity-0']" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="updateSettings({ markdownDefaultView: 'preview' })">
                    <Check :class="['size-3.5', markdownDefaultView === 'preview' ? 'opacity-100' : 'opacity-0']" />
                    Preview
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <div class="flex-1 min-h-0">
      <ResizablePanelGroup direction="horizontal" class="h-full" @layout="(s) => emit('explorer-layout', s)">
        <ResizablePanel
          :ref="(el) => emit('register-panel-ref', el)"
          collapsible
          :collapsed-size="0"
          :default-size="explorerSizePx"
          :min-size="LIST_PANEL_MIN_PX"
          :max-size="LIST_PANEL_MAX_PX"
          size-unit="px"
          class="bg-sidebar"
          @collapse="emit('explorer-collapse')"
        >
          <FilesPanel
            v-if="rootDir"
            :working-dir="rootDir"
            :active-file-path="activeFilePath"
            @open-file="(p, perm) => emit('open-file', p, !!perm)"
            @file-deleted="(path: string) => emit('close-tab', path)"
          />
        </ResizablePanel>
        <ResizableHandle class="cursor-ew-resize" @dragging="(v) => emit('dragging', v)" />
        <ResizablePanel :min-size="20">
          <div
            v-if="activeTab?.kind === 'explorer'"
            class="flex h-full items-center justify-center bg-sidebar"
          >
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><Files /></EmptyMedia>
                <EmptyTitle>No Files Open</EmptyTitle>
                <EmptyDescription>Open an existing file or create a new one.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <div class="flex gap-2">
                  <Button size="sm" variant="outline" @click="emit('open-file-search')">Open File</Button>
                  <Button size="sm" variant="outline" @click="emit('new-file')">New File</Button>
                </div>
              </EmptyContent>
            </Empty>
          </div>
          <div v-else-if="activeFileIsImage" class="flex flex-1 items-center justify-center overflow-auto p-8 h-full">
            <img v-if="!imageLoadError" :src="activeImageSrc" class="max-w-full max-h-full object-contain" @error="imageLoadError = true" />
            <Empty v-else>
              <EmptyHeader>
                <EmptyMedia variant="icon"><AlertTriangle class="size-5" /></EmptyMedia>
                <EmptyTitle>File deleted</EmptyTitle>
                <EmptyDescription>This file has been deleted or moved</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" variant="outline" @click="emit('close-tab', activeTab!.id)">Close Tab</Button>
              </EmptyContent>
            </Empty>
          </div>
          <CodeEditor
            v-else-if="activeTab?.kind === 'file'"
            :file-path="activeTab.filePath"
            :root-dir="rootDir"
            :initial-scroll-top="activeTab.scrollTop"
            :initial-cursor-line="activeTab.cursorLine"
            :initial-cursor-column="activeTab.cursorColumn"
            :position-version="activeTab.positionVersion"
            :markdown-preview="filePreview && activeFileExt === 'md'"
            :svg-preview="filePreview && activeFileExt === 'svg'"
            @dirty="(d, path) => emit('dirty', path || (activeTab!.kind === 'file' ? (activeTab as FilePanelFileTab).filePath : ''), d)"
            @close="emit('close-tab', activeTab!.id)"
            @view-state="(s) => emit('view-state', activeTab!.id, s)"
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </div>
</template>
