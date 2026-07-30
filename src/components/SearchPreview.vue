<script setup lang="ts">
import { ref, shallowRef, watch, onBeforeUnmount, nextTick } from "vue";
import * as monaco from "monaco-editor";
import { useRpc, type ContentSearchMatch } from "@/composables/useRpc";
import { useSettings } from "@/composables/useSettings";
import { useTheme } from "@/composables/useTheme";
import { ensureMonaco } from "@/lib/monacoBootstrap";
import { detectMonacoLanguage } from "@/lib/languageDetect";
import SearchPreviewHeader from "./SearchPreviewHeader.vue";

const props = defineProps<{
  match: ContentSearchMatch | null;
  rootDir?: string;
  listVisible: boolean;
}>();

const emit = defineEmits<{ "update:listVisible": [v: boolean] }>();

const { settings } = useSettings();
const { activeThemeName, getActiveThemeSpec } = useTheme();

const containerRef = ref<HTMLElement | null>(null);
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
let decorations: monaco.editor.IEditorDecorationsCollection | null = null;
let currentModel: monaco.editor.ITextModel | null = null;

function disposeEditor() {
  decorations?.clear();
  decorations = null;
  editor.value?.dispose();
  editor.value = null;
  currentModel?.dispose();
  currentModel = null;
}

async function loadMatch(m: ContentSearchMatch | null) {
  disposeEditor();
  if (!m || !containerRef.value) return;

  const pathSnap = m.path;
  const lineSnap = m.line;
  const colSnap = m.column;
  const matchLen = m.match.length;

  try {
    const { content } = await useRpc().request.readFile({ path: pathSnap });
    if (props.match?.path !== pathSnap) return;

    const themeSpec = getActiveThemeSpec();
    await ensureMonaco(themeSpec, activeThemeName.value);

    const uri = monaco.Uri.file(pathSnap);
    currentModel = monaco.editor.createModel(content, detectMonacoLanguage(pathSnap), uri);

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
    <SearchPreviewHeader
      :match="match"
      :list-visible="listVisible"
      @update:list-visible="emit('update:listVisible', $event)"
    />
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
