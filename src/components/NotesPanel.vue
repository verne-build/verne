<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useRpc } from "@/composables/useRpc";
import { listen, type UnlistenFn } from "@/platform";
import type { NoteMeta } from "@/types";
import { PANEL_SIZES } from "@/lib/panelSizes";
import { readCachedPanelState, writeCachedPanelPx } from "@/lib/bootstrapCache";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./ui/resizable";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import SegmentedTabs, { type SegmentedOption } from "./SegmentedTabs.vue";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "./ui/dropdown-menu";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "./ui/context-menu";
import CodeEditor from "./CodeEditor.vue";
import PanelLeftFilled from "./icons/PanelLeftFilled.vue";
import { Plus, NotebookText, PanelLeft, MoreHorizontal, PenLine, Eye } from "@lucide/vue";
import { ask } from "@/platform";
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from "./ui/empty";
defineOptions({ inheritAttrs: false });

const props = defineProps<{ directoryId: string }>();
const { request } = useRpc();

// Note-scoped editor prefs — independent of the global file-editor settings.
// Notes-friendly defaults; persisted in app_state.
interface SpPrefs { wordWrap: boolean; lineNumbers: boolean; minimap: boolean; defaultView: "edit" | "preview"; }
const PREFS_KEY = "notes_editor_prefs";
const prefs = ref<SpPrefs>({ wordWrap: true, lineNumbers: false, minimap: false, defaultView: "edit" });

function savePrefs() {
  request.setAppState({ key: PREFS_KEY, value: JSON.stringify(prefs.value) }).catch(() => {});
}
function setPref<K extends keyof SpPrefs>(k: K, v: SpPrefs[K]) {
  prefs.value = { ...prefs.value, [k]: v };
  savePrefs();
}
function setView(p: boolean) {
  preview.value = p;
  setPref("defaultView", p ? "preview" : "edit");
}

const ACTIVE_PAD_KEY = "notes_active_by_directory";
const VIEW_STATE_KEY = "notes_view_state_by_directory";

onMounted(async () => {
  try {
    const raw = await request.getAppState({ key: PREFS_KEY });
    if (raw) prefs.value = { ...prefs.value, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  preview.value = prefs.value.defaultView === "preview";
  try {
    const raw = await request.getAppState({ key: "notes_list_px" });
    const n = raw === null ? NaN : parseFloat(raw);
    if (Number.isFinite(n)) {
      listSizePx.value = clampListPx(n);
      nextTick(() => { if (listVisible.value) listPanelRef.value?.resize(listSizePx.value); });
    }
  } catch { /* ignore */ }
});

// Remember the selected pad per workspace across tab switches and app launches.
const selectionByDir = new Map<string, string>();
let selectionLoadPromise: Promise<void> | null = null;
let selectionLoaded = false;

function selectionSnapshot() {
  return JSON.stringify(Object.fromEntries(selectionByDir.entries()));
}

async function loadPersistedSelections() {
  if (selectionLoaded) return;
  if (!selectionLoadPromise) {
    selectionLoadPromise = (async () => {
      try {
        const raw = await request.getAppState({ key: ACTIVE_PAD_KEY });
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [directoryId, slug] of Object.entries(parsed)) {
            if (typeof directoryId === "string" && typeof slug === "string" && !selectionByDir.has(directoryId)) {
              selectionByDir.set(directoryId, slug);
            }
          }
        }
      } catch { /* ignore */ }
      selectionLoaded = true;
    })();
  }
  await selectionLoadPromise;
}

function rememberSelection(directoryId: string, slug: string | null) {
  if (slug) selectionByDir.set(directoryId, slug);
  else selectionByDir.delete(directoryId);
  request.setAppState({ key: ACTIVE_PAD_KEY, value: selectionSnapshot() }).catch(() => {});
}

type EditorViewState = { scrollTop?: number; cursorLine?: number; cursorColumn?: number };
type NoteViewStateMap = Record<string, Record<string, EditorViewState>>;

const viewStateByDir = new Map<string, Map<string, EditorViewState>>();
let viewStateLoadPromise: Promise<void> | null = null;
let viewStateLoaded = false;

function viewStateSnapshot() {
  const out: NoteViewStateMap = {};
  for (const [directoryId, bySlug] of viewStateByDir.entries()) {
    const slugStates: Record<string, EditorViewState> = {};
    for (const [slug, state] of bySlug.entries()) slugStates[slug] = state;
    out[directoryId] = slugStates;
  }
  return JSON.stringify(out);
}

async function loadPersistedViewStates() {
  if (viewStateLoaded) return;
  if (!viewStateLoadPromise) {
    viewStateLoadPromise = (async () => {
      try {
        const raw = await request.getAppState({ key: VIEW_STATE_KEY });
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [directoryId, bySlug] of Object.entries(parsed)) {
            if (!bySlug || typeof bySlug !== "object" || Array.isArray(bySlug)) continue;
            const states = new Map<string, EditorViewState>();
            for (const [slug, state] of Object.entries(bySlug)) {
              if (!state || typeof state !== "object" || Array.isArray(state)) continue;
              const view = state as EditorViewState;
              states.set(slug, {
                scrollTop: typeof view.scrollTop === "number" ? view.scrollTop : undefined,
                cursorLine: typeof view.cursorLine === "number" ? view.cursorLine : undefined,
                cursorColumn: typeof view.cursorColumn === "number" ? view.cursorColumn : undefined,
              });
            }
            if (states.size > 0) viewStateByDir.set(directoryId, states);
          }
        }
      } catch { /* ignore */ }
      viewStateLoaded = true;
    })();
  }
  await viewStateLoadPromise;
}

function setPadViewState(directoryId: string, slug: string, state: EditorViewState | null) {
  let states = viewStateByDir.get(directoryId);
  if (!states) {
    states = new Map<string, EditorViewState>();
    viewStateByDir.set(directoryId, states);
  }
  if (state) states.set(slug, state);
  else states.delete(slug);
  if (states.size === 0) viewStateByDir.delete(directoryId);
  request.setAppState({ key: VIEW_STATE_KEY, value: viewStateSnapshot() }).catch(() => {});
}

const selectedViewState = computed(() =>
  selectedSlug.value ? viewStateByDir.get(props.directoryId)?.get(selectedSlug.value) : undefined,
);

const items = ref<NoteMeta[]>([]);
const selectedSlug = ref<string | null>(null);
const selected = computed(() => items.value.find(i => i.slug === selectedSlug.value) ?? null);
const loadedDirectoryId = ref<string | null>(null);
const hasLoadedCurrentDirectory = computed(() => loadedDirectoryId.value === props.directoryId);
const editorRef = ref<InstanceType<typeof CodeEditor> | null>(null);
const renamingSlug = ref<string | null>(null);
const breadcrumbRenaming = ref(false);
const renameTitle = ref("");

const dirPath = ref<string | null>(null);
const padPath = computed(() =>
  dirPath.value && selectedSlug.value ? `${dirPath.value}/${selectedSlug.value}.md` : null,
);

// Preview vs source edit — defaults to edit; synced from note prefs on mount.
const preview = ref(false);

const previewTabOptions: SegmentedOption[] = [
  { value: "edit", label: "Edit", icon: PenLine },
  { value: "preview", label: "Preview", icon: Eye },
];

// --- list show/hide (mirrors the file explorer toggle) ---
// Auto-hidden for 0–1 pads (the list is wasted space with a single note) and
// auto-shown at 2+. Only flips when the count CROSSES the threshold, so a manual
// toggle within a range is respected; re-evaluated per workspace.
const listVisible = ref(false);
const listPanelRef = ref<any>(null);
const splitDragging = ref(false);
const clampListPx = (v: number) =>
  Math.min(PANEL_SIZES.list.max, Math.max(PANEL_SIZES.list.min, v));
const listSizePx = ref(
  clampListPx(readCachedPanelState().notesPx ?? PANEL_SIZES.list.defaults.notes),
);
function preventDragCollapse() {
  if (!splitDragging.value) return;
  nextTick(() => listPanelRef.value?.resize(PANEL_SIZES.list.min));
}
let listSaveTimer: ReturnType<typeof setTimeout> | null = null;
function onListLayout(sizes: number[]) {
  // Collapsed (hidden) → sizes[0] is 0; don't clobber the saved width.
  if (!listVisible.value || !(sizes[0] > 0)) return;
  listSizePx.value = sizes[0];
  writeCachedPanelPx("notes", sizes[0]);
  if (listSaveTimer) clearTimeout(listSaveTimer);
  listSaveTimer = setTimeout(() => {
    request.setAppState({ key: "notes_list_px", value: String(Math.round(sizes[0])) });
  }, 500);
}
watch(listVisible, (v) => { v ? listPanelRef.value?.expand() : listPanelRef.value?.collapse(); });
watch(listPanelRef, (r) => { if (r && !listVisible.value) nextTick(() => r.collapse()); });

let prevCount = -1;
let countDir: string | null = null;
function applyListAuto() {
  if (countDir !== props.directoryId) { countDir = props.directoryId; prevCount = -1; }
  const n = items.value.length;
  const isMulti = n >= 2;
  if (prevCount === -1 || (prevCount >= 2) !== isMulti) listVisible.value = isMulti;
  prevCount = n;
}

// --- live reload (agent writes ↔ open editor) ---
const editorDirty = ref(false);
const reloadKey = ref(0);
let lastSelfWrite = 0;
let watchedPath: string | null = null;
let unlistenDir: UnlistenFn | null = null;
let refreshGeneration = 0;
let watchGeneration = 0;

async function refresh(preferSlug?: string) {
  const generation = ++refreshGeneration;
  const directoryId = props.directoryId;
  await Promise.all([loadPersistedSelections(), loadPersistedViewStates()]);
  if (generation !== refreshGeneration || directoryId !== props.directoryId) return;
  try {
    const next = await request.notesList({ directoryId });
    if (generation !== refreshGeneration || directoryId !== props.directoryId) return;
    items.value = next;
  } catch {
    if (generation !== refreshGeneration || directoryId !== props.directoryId) return;
    items.value = [];
  }
  const want = preferSlug ?? selectionByDir.get(directoryId) ?? selectedSlug.value;
  if (want && items.value.some(i => i.slug === want)) select(want);
  else if (items.value.length > 0) select(items.value[0].slug);
  else {
    selectedSlug.value = null;
    rememberSelection(directoryId, null);
  }
  loadedDirectoryId.value = directoryId;
  applyListAuto();
}

function select(slug: string) {
  selectedSlug.value = slug;
  rememberSelection(props.directoryId, slug);
}

async function newPad() {
  try {
    const meta = await request.notesCreate({ directoryId: props.directoryId, title: "Untitled" });
    preview.value = false; // drop into edit mode so the user can title it
    await refresh(meta.slug);
  } catch { /* ignore */ }
}

async function deletePad(slug: string, title: string) {
  const ok = await ask(`Delete "${title}"? This can't be undone.`, { title: "Delete note", kind: "warning" });
  if (!ok) return;
  try { await request.notesDelete({ directoryId: props.directoryId, slug }); } catch { /* ignore */ }
  if (selectedSlug.value === slug) {
    selectedSlug.value = null;
    rememberSelection(props.directoryId, null);
  }
  setPadViewState(props.directoryId, slug, null);
  await refresh();
}

function startBreadcrumbRename() {
  if (!selected.value) return;
  renamingSlug.value = null;
  breadcrumbRenaming.value = true;
  renameTitle.value = selected.value.title || selected.value.slug;
}

function onBreadcrumbRenameBlur() {
  void commitRename(selected.value?.slug);
}

function startInlineRename(item: NoteMeta) {
  select(item.slug);
  breadcrumbRenaming.value = false;
  renamingSlug.value = item.slug;
  renameTitle.value = item.title || item.slug;
}

function cancelRename() {
  breadcrumbRenaming.value = false;
  renamingSlug.value = null;
  renameTitle.value = "";
}

async function commitRename(slug = renamingSlug.value, value = renameTitle.value) {
  const title = value.trim();
  if (!slug || !title) {
    cancelRename();
    return;
  }
  const current = items.value.find(item => item.slug === slug);
  if (!current) {
    cancelRename();
    return;
  }
  if (title === current.title) {
    cancelRename();
    return;
  }
  // Clear the inline editor before awaiting so blur and Enter cannot submit twice.
  renamingSlug.value = null;
  try {
    if (selectedSlug.value === slug) {
      await editorRef.value?.save();
      if (editorDirty.value) return;
    }
    lastSelfWrite = Date.now();
    const meta = await request.notesRename({
      directoryId: props.directoryId,
      slug,
      title,
    });
    rememberSelection(props.directoryId, meta.slug);
    const renamedViewState = viewStateByDir.get(props.directoryId)?.get(slug);
    if (renamedViewState) {
      setPadViewState(props.directoryId, meta.slug, renamedViewState);
      setPadViewState(props.directoryId, slug, null);
    }
    breadcrumbRenaming.value = false;
    renameTitle.value = "";
    await refresh(meta.slug);
    reloadKey.value++;
  } catch {
    breadcrumbRenaming.value = false;
    renameTitle.value = "";
  }
}

// CodeEditor saves the file directly; on dirty→false (save or load) suppress the
// watcher echo and refresh the list so metadata changes stay current.
function onEditorDirty(d: boolean) {
  editorDirty.value = d;
  if (!d) { lastSelfWrite = Date.now(); refresh(); }
}

function onEditorViewState(state: EditorViewState) {
  if (!selectedSlug.value) return;
  setPadViewState(props.directoryId, selectedSlug.value, state);
}

async function startWatch() {
  const generation = ++watchGeneration;
  const directoryId = props.directoryId;
  await stopWatch();
  try {
    const path = await request.notesDirPath({ directoryId });
    if (generation !== watchGeneration || directoryId !== props.directoryId) {
      try { await request.unwatchDirectory({ path }); } catch { /* ignore */ }
      return;
    }
    dirPath.value = path;
    watchedPath = path;
    await request.watchDirectory({ path });
    if (generation !== watchGeneration || directoryId !== props.directoryId) {
      if (watchedPath === path) watchedPath = null;
      try { await request.unwatchDirectory({ path }); } catch { /* ignore */ }
      return;
    }
    unlistenDir = await listen<string>("directory-changed", (e) => {
      if (generation !== watchGeneration || directoryId !== props.directoryId) return;
      if (Date.now() - lastSelfWrite < 1500) return; // ignore our own save echo
      const changed = e.payload;
      if (watchedPath && changed && changed !== watchedPath) return;
      onExternalChange();
    });
  } catch { /* best-effort */ }
}

async function stopWatch() {
  if (unlistenDir) { unlistenDir(); unlistenDir = null; }
  if (watchedPath) {
    const p = watchedPath; watchedPath = null;
    try { await request.unwatchDirectory({ path: p }); } catch { /* ignore */ }
  }
}

async function onExternalChange() {
  await refresh();
  if (selectedSlug.value && !editorDirty.value) reloadKey.value++; // reload open pad if clean
}

watch(
  () => props.directoryId,
  () => { editorDirty.value = false; refresh(); startWatch(); },
  { immediate: true },
);

onBeforeUnmount(() => {
  refreshGeneration++;
  watchGeneration++;
  void stopWatch();
});
</script>

<template>
  <div v-bind="$attrs" class="h-full flex flex-col min-h-0">
    <!-- Top bar — matches the file breadcrumb bar (h-8). -->
    <div class="flex items-center gap-1 px-2 h-8 text-xs text-muted-foreground bg-sidebar border-b border-border shrink-0">
      <Button
        size="icon-xs"
        variant="ghost"
        class="text-muted-foreground shrink-0"
        :title="listVisible ? 'Hide list' : 'Show list'"
        @click="listVisible = !listVisible"
      >
        <PanelLeft v-if="!listVisible" class="size-3.5" />
        <PanelLeftFilled v-else class="size-3.5" />
      </Button>
      <input
        v-if="breadcrumbRenaming && selected"
        v-focus
        data-notes-breadcrumb-rename
        class="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none border-b border-primary"
        :value="renameTitle"
        @input="renameTitle = ($event.target as HTMLInputElement).value"
        @keydown.enter.prevent.stop="commitRename(selected.slug)"
        @keydown.escape.prevent.stop="cancelRename"
        @blur="onBreadcrumbRenameBlur"
        @click.stop
        @dblclick.stop
      />
      <span
        v-else
        data-no-drag
        role="button"
        tabindex="0"
        class="truncate"
        :class="selected ? 'text-foreground cursor-default' : ''"
        @mousedown.stop
        @dblclick.prevent.stop="startBreadcrumbRename"
        @keydown.enter="startBreadcrumbRename"
      >
        {{ selected ? (selected.title || selected.slug) : "Notes" }}
      </span>
      <div class="flex items-center shrink-0 ml-auto gap-0.5">
        <template v-if="selected">
          <SegmentedTabs
            :model-value="preview ? 'preview' : 'edit'"
            :options="previewTabOptions"
            @update:model-value="(v) => setView(v === 'preview')"
          />
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button class="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground transition-colors" aria-label="Note options">
                <MoreHorizontal class="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" size="sm" class="min-w-44">
              <DropdownMenuItem class="justify-between" @select.prevent="setPref('wordWrap', !prefs.wordWrap)">
                <span>Word Wrap</span>
                <Switch :model-value="prefs.wordWrap" class="ml-2 scale-75 origin-right" @update:model-value="(v: boolean) => setPref('wordWrap', v)" @click.stop />
              </DropdownMenuItem>
              <DropdownMenuItem class="justify-between" @select.prevent="setPref('lineNumbers', !prefs.lineNumbers)">
                <span>Line Numbers</span>
                <Switch :model-value="prefs.lineNumbers" class="ml-2 scale-75 origin-right" @update:model-value="(v: boolean) => setPref('lineNumbers', v)" @click.stop />
              </DropdownMenuItem>
              <DropdownMenuItem class="justify-between" @select.prevent="setPref('minimap', !prefs.minimap)">
                <span>Minimap</span>
                <Switch :model-value="prefs.minimap" class="ml-2 scale-75 origin-right" @update:model-value="(v: boolean) => setPref('minimap', v)" @click.stop />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </template>
      </div>
    </div>

    <div class="flex-1 min-h-0">
      <ResizablePanelGroup direction="horizontal" class="h-full" @layout="onListLayout">
        <ResizablePanel
          ref="listPanelRef"
          collapsible
          :collapsed-size="0"
          :default-size="listSizePx"
          :min-size="PANEL_SIZES.list.min"
          :max-size="PANEL_SIZES.list.max"
          size-unit="px"
          class="bg-sidebar flex flex-col min-h-0"
          @collapse="preventDragCollapse"
        >
          <!-- List header — matches the file explorer header. -->
          <TooltipProvider :delay-duration="1000">
            <div class="flex items-center justify-between gap-2 px-2 py-1 text-muted-foreground shrink-0">
              <div class="min-w-0 truncate px-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                Notes
              </div>
              <div class="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button size="icon-xs" variant="ghost" class="text-muted-foreground hover:text-foreground" @click="newPad">
                      <Plus class="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">New Note</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </TooltipProvider>
          <ScrollArea class="flex-1 min-h-0">
            <div class="py-1">
              <ContextMenu
                v-for="it in items"
                :key="it.slug"
              >
                <ContextMenuTrigger as-child>
                  <div
                    class="flex items-center h-[22px] gap-1.5 px-1.5 mx-2 rounded-md cursor-default select-none text-xs"
                    :class="it.slug === selectedSlug ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent/50'"
                    @click="select(it.slug)"
                    @dblclick="startInlineRename(it)"
                    @contextmenu="select(it.slug)"
                  >
                    <NotebookText class="size-3.5 shrink-0 opacity-70" />
                    <input
                      v-if="renamingSlug === it.slug"
                      v-focus
                      class="min-w-0 flex-1 bg-transparent outline outline-1 outline-border rounded px-1 text-xs"
                      :value="renameTitle"
                      @input="renameTitle = ($event.target as HTMLInputElement).value"
                      @keydown.enter.prevent.stop="commitRename(it.slug)"
                      @keydown.escape.prevent.stop="cancelRename"
                      @blur="commitRename(it.slug)"
                      @click.stop
                      @dblclick.stop
                    />
                    <span v-else class="min-w-0 flex-1 truncate">{{ it.title || it.slug }}</span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent @close-auto-focus.prevent>
                  <ContextMenuItem @select="startInlineRename(it)">Rename</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    @select="deletePad(it.slug, it.title)"
                  >
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <div v-if="hasLoadedCurrentDirectory && items.length === 0" class="px-3 py-2 text-xs text-muted-foreground">No notes</div>
            </div>
          </ScrollArea>
        </ResizablePanel>
        <ResizableHandle class="cursor-ew-resize" @dragging="splitDragging = $event" />
        <ResizablePanel :min-size="30">
          <CodeEditor
            v-if="selected && padPath"
            ref="editorRef"
            :key="selected.slug + ':' + reloadKey"
            :file-path="padPath"
            :markdown-preview="preview"
            :initial-scroll-top="selectedViewState?.scrollTop"
            :initial-cursor-line="selectedViewState?.cursorLine"
            :initial-cursor-column="selectedViewState?.cursorColumn"
            :word-wrap="prefs.wordWrap"
            :line-numbers="prefs.lineNumbers"
            :minimap="prefs.minimap"
            :auto-save="true"
            :preserve-frontmatter="true"
            :frontmatter-title="selected.title || selected.slug"
            @dirty="onEditorDirty"
            @view-state="onEditorViewState"
          />
          <Empty v-else-if="hasLoadedCurrentDirectory" class="h-full bg-sidebar">
            <EmptyHeader>
              <EmptyMedia variant="icon"><NotebookText /></EmptyMedia>
              <EmptyTitle>No notes yet</EmptyTitle>
              <EmptyDescription>
                Notes you keep alongside your agents. Create one, then ask an agent to read from or write to it.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" @click="newPad"><Plus class="size-3.5 mr-1" /> New Note</Button>
            </EmptyContent>
          </Empty>
          <div v-else class="h-full bg-[var(--editor-bg)]" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </div>
</template>
