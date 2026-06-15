<script setup lang="ts">
import { ref, shallowRef, watch, onBeforeUnmount, nextTick } from "vue";
import * as monaco from "monaco-editor";
import { SquareArrowOutUpRight } from "@lucide/vue";
import { useRpc, type ContentSearchMatch } from "@/composables/useRpc";
import { useSettings } from "@/composables/useSettings";
import { useTheme } from "@/composables/useTheme";
import { ensureMonaco } from "@/lib/monacoBootstrap";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "./ui/tooltip";

const props = defineProps<{
  match: ContentSearchMatch | null;
  rootDir?: string;
}>();

const { settings } = useSettings();
const { activeThemeName, getActiveThemeSpec } = useTheme();

const containerRef = ref<HTMLElement | null>(null);
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
let decorations: monaco.editor.IEditorDecorationsCollection | null = null;
let currentModel: monaco.editor.ITextModel | null = null;

function pathParts(relPath: string) {
  const i = relPath.lastIndexOf("/");
  if (i === -1) return { directory: "", filename: relPath };
  return { directory: relPath.slice(0, i + 1), filename: relPath.slice(i + 1) };
}

function disposeEditor() {
  decorations?.clear();
  decorations = null;
  editor.value?.dispose();
  editor.value = null;
  currentModel?.dispose();
  currentModel = null;
}

function openInEditor() {
  const m = props.match;
  if (!m) return;
  window.dispatchEvent(new CustomEvent("open-file-tab", {
    detail: { path: m.path, position: { line: m.line, column: m.column } },
  }));
}

async function loadMatch(m: ContentSearchMatch | null) {
  disposeEditor();
  if (!m || !containerRef.value) return;

  const pathSnap = m.path;
  const lineSnap = m.line;
  const colSnap = m.column;
  const matchLen = m.match.length;

  try {
    const { content, language } = await useRpc().request.readFile({ path: pathSnap });
    if (props.match?.path !== pathSnap) return;

    const themeSpec = getActiveThemeSpec();
    await ensureMonaco(themeSpec, activeThemeName.value);

    const uri = monaco.Uri.file(pathSnap);
    currentModel = monaco.editor.createModel(content, language, uri);

    const fontSize = settings.value.editorFontSize;
    const lh = settings.value.editorLineHeight;
    editor.value = monaco.editor.create(containerRef.value, {
      theme: activeThemeName.value,
      model: currentModel,
      readOnly: true,
      fontSize,
      lineHeight: lh === 0 ? Math.round(fontSize * 1.5) : Math.max(lh, fontSize),
      fontFamily: settings.value.editorFontFamily,
      wordWrap: settings.value.editorWordWrap ? "on" : "off",
      lineNumbers: "on",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      automaticLayout: true,
      contextmenu: false,
      stickyScroll: { enabled: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });

    if (props.match?.path !== pathSnap) return;

    const lineEndCol = currentModel.getLineMaxColumn(lineSnap);
    const matchEndCol = Math.min(lineEndCol, colSnap + matchLen);

    editor.value.revealLineInCenter(lineSnap);
    editor.value.setPosition({ lineNumber: lineSnap, column: colSnap });
    decorations = editor.value.createDecorationsCollection([
      {
        range: new monaco.Range(lineSnap, 1, lineSnap, lineEndCol),
        options: { isWholeLine: true, className: "search-match-line" },
      },
      {
        range: new monaco.Range(lineSnap, colSnap, lineSnap, matchEndCol),
        options: { className: "search-match-keyword" },
      },
    ]);
  } catch {
    // preview stays empty on read failure
  }
}

watch(
  () => props.match,
  async (m) => {
    await nextTick();
    await loadMatch(m);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  disposeEditor();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      v-if="match"
      class="flex h-8 shrink-0 items-center justify-between gap-1 overflow-hidden border-b border-border bg-sidebar px-2 text-xs text-muted-foreground"
    >
      <span
        :title="match.relPath"
        class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl]"
      >
        <span class="[direction:ltr]">
          <span class="text-muted-foreground">{{ pathParts(match.relPath).directory }}</span>
          <span class="text-foreground">{{ pathParts(match.relPath).filename }}</span>
        </span>
      </span>
      <TooltipProvider :delay-duration="400">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button size="icon-xs" variant="ghost" class="shrink-0" @click="openInEditor">
              <SquareArrowOutUpRight class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" class="text-xs">Open in Editor</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
    <div ref="containerRef" class="min-h-0 flex-1" />
  </div>
</template>

<style>
.search-match-line {
  background: var(--editor-findMatchHighlight, rgba(255, 200, 0, 0.12));
}

.search-match-keyword {
  background: var(--editor-findMatchHighlight, rgba(255, 200, 0, 0.45));
  border-radius: 2px;
}
</style>
