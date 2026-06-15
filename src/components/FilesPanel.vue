<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { listen, type UnlistenFn } from "@/platform";
import { useRpc } from "@/composables/useRpc";
import { useFileTreeModel, type TreeNode } from "@/composables/useFileTreeModel";
import { useSettings } from "@/composables/useSettings";
import FileTreeView from "./FileTreeView.vue";
import { CopyMinus, FilePlusCorner, FolderPlus } from "@lucide/vue";
import { Button } from "./ui/button";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { toast } from "vue-sonner";
import { syncFilePanelFilePath } from "@/composables/useFilePanelTabs";
import { setDraggedPath } from "@/lib/dropPath";

const props = defineProps<{
  workingDir: string;
  activeFilePath?: string | null;
}>();
const emit = defineEmits<{
  // permanent=true opens a pinned tab (double-click, Enter, create); a plain
  // single click omits it and opens a preview tab.
  openFile: [path: string, permanent?: boolean];
  fileDeleted: [path: string];
  fileRenamed: [oldPath: string, newPath: string];
}>();

const model = useFileTreeModel(() => props.workingDir);
const view = ref<InstanceType<typeof FileTreeView> | null>(null);
const visibleRows = model.visibleRows;

const expandedKey = () => `tree_expanded:${props.workingDir}`;
const scrollKey = () => `tree_scroll:${props.workingDir}`;

const directoryName = computed(() => {
  const parts = props.workingDir.split("/").filter(Boolean);
  return parts[parts.length - 1] || props.workingDir.replace(/^\/Users\/[^/]+/, "~");
});

// Context-menu state (wired to the cursor-anchored DropdownMenu below; full
// action wiring lands in a later task).
const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);
const menuItem = ref<TreeNode | null>(null);

// ─── Persistence ─────────────────────────────────────────────────────────
let saveExpandedTimer: ReturnType<typeof setTimeout> | null = null;
let saveScrollTimer: ReturnType<typeof setTimeout> | null = null;

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await useRpc().request.getAppState({ key });
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Bumped per build so a workspace switch mid-build abandons the stale one
// instead of two concurrent builds racing on the shared model.
let buildGen = 0;
async function buildTree() {
  const gen = ++buildGen;
  await model.loadRoot();
  if (gen !== buildGen) return;
  const persisted = await loadJson<string[]>(expandedKey(), []);
  if (gen !== buildGen) return;
  persisted.sort((a, b) => a.split("/").length - b.split("/").length);
  for (const p of persisted) {
    if (model.nodes.value.has(p)) await model.expand(p);
    if (gen !== buildGen) return;
  }
  await nextTick();
  if (gen !== buildGen) return;
  const top = await loadJson<number>(scrollKey(), 0);
  if (gen !== buildGen) return;
  view.value?.setScrollTop(top);
}

function persistExpanded() {
  const paths = model.expandedPaths();
  useRpc().request.setAppState({ key: expandedKey(), value: JSON.stringify(paths) }).catch(() => {});
}
function scheduleSaveExpanded() {
  if (saveExpandedTimer) clearTimeout(saveExpandedTimer);
  saveExpandedTimer = setTimeout(persistExpanded, 300);
}
function onScroll(top: number) {
  if (saveScrollTimer) clearTimeout(saveScrollTimer);
  saveScrollTimer = setTimeout(() => {
    useRpc().request.setAppState({ key: scrollKey(), value: JSON.stringify(top) }).catch(() => {});
  }, 300);
}

// ─── Row open / toggle / active-file sync ────────────────────────────────
async function onToggle(node: TreeNode) {
  await model.toggle(node.path);
  scheduleSaveExpanded();
}

// Anchor stored as a PATH (not an index) so expand/collapse between clicks
// doesn't shift the shift-select range.
let anchorPath: string | null = null;
function indexOfPath(p: string) { return visibleRows.value.findIndex((n) => n.path === p); }

function onRowClick(node: TreeNode, e: MouseEvent) {
  const idx = indexOfPath(node.path);
  const sel = new Set(model.selected.value);
  const anchorIdx = anchorPath ? indexOfPath(anchorPath) : -1;
  if (e.metaKey) {
    sel.has(node.path) ? sel.delete(node.path) : sel.add(node.path);
    anchorPath = node.path;
  } else if (e.shiftKey && anchorIdx >= 0) {
    sel.clear();
    const [a, b] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
    for (let i = a; i <= b; i++) sel.add(visibleRows.value[i].path);
  } else {
    sel.clear(); sel.add(node.path); anchorPath = node.path;
    if (node.isDir) onToggle(node);
    else emit("openFile", node.path); // single click → preview (ephemeral)
  }
  model.selected.value = sel;
  model.triggerNodes();
}

// Double-click promotes to a permanent tab (VS Code).
function onRowDblClick(node: TreeNode) {
  if (!node.isDir) emit("openFile", node.path, true);
}

function activePathOrFirst(): string | null {
  const s = [...model.selected.value];
  return s.length ? s[s.length - 1] : (visibleRows.value[0]?.path ?? null);
}
async function onKeydown(e: KeyboardEvent) {
  // Don't hijack arrows/Enter while editing a rename/new-entry input.
  if (e.target instanceof HTMLInputElement) return;
  const rows = visibleRows.value;
  if (!rows.length) return;
  const cur = activePathOrFirst();
  let idx = cur ? indexOfPath(cur) : 0;
  if (e.key === "ArrowDown") { idx = Math.min(rows.length - 1, idx + 1); }
  else if (e.key === "ArrowUp") { idx = Math.max(0, idx - 1); }
  else if (e.key === "ArrowRight") { const n = rows[idx]; if (n?.isDir && !n.expanded) { await onToggle(n); return; } }
  else if (e.key === "ArrowLeft") { const n = rows[idx]; if (n?.isDir && n.expanded) { await onToggle(n); return; } }
  else if (e.key === "Enter") { const n = rows[idx]; if (n && !n.isDir) emit("openFile", n.path, true); return; }
  else return;
  e.preventDefault();
  const n = rows[idx];
  model.selected.value = new Set([n.path]); anchorPath = n.path; model.triggerNodes();
  view.value?.scrollToIndex(idx);
}

async function syncActive(abs: string | null | undefined) {
  if (!abs || !abs.startsWith(props.workingDir + "/")) return;
  const rel = abs.slice(props.workingDir.length + 1).split("/");
  let cur = props.workingDir;
  for (let i = 0; i < rel.length - 1; i++) {
    cur = `${cur}/${rel[i]}`;
    if (model.nodes.value.has(cur)) await model.expand(cur);
  }
  model.selected.value = new Set([abs]);
  model.triggerNodes();
  await nextTick();
  const idx = visibleRows.value.findIndex((n) => n.path === abs);
  if (idx >= 0) view.value?.scrollToIndex(idx);
}
watch(() => props.activeFilePath, syncActive);

// ─── File watching (per-dir refresh) ─────────────────────────────────────
let watchedDir: string | null = null;
let unlistenDir: UnlistenFn | null = null;

// Re-list one directory in place (root or a loaded subdir), preserving the rest.
async function reloadDir(absDir: string) {
  if (absDir === props.workingDir) {
    model.rootChildren.value = await model.loadDir(props.workingDir, 0);
  } else {
    const n = model.nodes.value.get(absDir);
    if (n && n.childPaths !== null) n.childPaths = await model.loadDir(absDir, n.depth + 1);
  }
  model.bump();
}

async function refreshDir(changedPath: string) {
  // Don't clobber an in-progress rename/new-entry input with a watch-driven
  // re-list (it would unmount the input). Explicit reloads after commit handle it.
  if (renamingPath.value) return;
  const dir = changedPath.endsWith("/") ? changedPath.slice(0, -1) : changedPath;
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  await reloadDir(model.nodes.value.has(parent) ? parent : props.workingDir);
}

let watchGen = 0;
async function startWatching(dir: string) {
  const gen = ++watchGen;
  if (unlistenDir) { unlistenDir(); unlistenDir = null; }
  if (watchedDir) { useRpc().request.unwatchDirectory({ path: watchedDir }).catch(() => {}); watchedDir = null; }
  useRpc().request.watchDirectory({ path: dir }).catch(() => {});
  watchedDir = dir;
  const ud = await listen<string>("directory-changed", (e) => refreshDir(e.payload));
  // A newer startWatching superseded us while awaiting listen() — tear down the
  // listener we just created instead of leaking it.
  if (gen !== watchGen) { ud(); return; }
  unlistenDir = ud;
}

// ─── Drag-and-drop ───────────────────────────────────────────────────────
// The directory a drop would land in (highlighted during a drag).
const dragOverDir = ref<string | null>(null);

function onRowDragStart(node: TreeNode, e: DragEvent) {
  if (!model.selected.value.has(node.path)) {
    model.selected.value = new Set([node.path]); model.triggerNodes();
  }
  const paths = [...model.selected.value];
  setDraggedPath(paths[0] ?? node.path);
  e.dataTransfer?.setData("application/x-verne-paths", JSON.stringify(paths));
  // copyMove (not move): explorer dirs drop as "move", but the terminal drops
  // the path as "copy" — effectAllowed=move makes Chromium reject the copy drop
  // (no `drop` event fires), so the terminal never pastes.
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
}
// Spring-loaded folders: hovering a collapsed dir mid-drag expands it.
let springTimer: ReturnType<typeof setTimeout> | null = null;
let springPath: string | null = null;
function clearSpring() {
  if (springTimer) { clearTimeout(springTimer); springTimer = null; }
  springPath = null;
}

function onRowDragOver(node: TreeNode, e: DragEvent) {
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dragOverDir.value = (node.isDir ? node.path : node.parentPath) || null;
  if (node.isDir && !node.expanded) {
    if (springPath !== node.path) {
      clearSpring();
      springPath = node.path;
      springTimer = setTimeout(() => {
        if (dragOverDir.value === node.path) model.expand(node.path).then(scheduleSaveExpanded);
        clearSpring();
      }, 600);
    }
  } else {
    clearSpring();
  }
}
function onRowDragEnd() { setDraggedPath(null); dragOverDir.value = null; clearSpring(); }
function onRowDrop(target: TreeNode, e: DragEvent) {
  dragOverDir.value = null;
  clearSpring();
  const targetDir = target.isDir ? target.path : target.parentPath;
  if (!targetDir) return;
  const raw = e.dataTransfer?.getData("application/x-verne-paths");
  const all: string[] = raw ? JSON.parse(raw) : [];
  // Skip no-op / invalid moves: already in this dir, onto itself, or into its
  // own subtree (the last two would be destructive / nonsensical).
  const paths = all.filter((src) => {
    const srcParent = src.slice(0, src.lastIndexOf("/"));
    return srcParent !== targetDir && targetDir !== src && !targetDir.startsWith(src + "/");
  });
  if (!paths.length) return;
  Promise.allSettled(
    paths.map((src) =>
      useRpc().request.pastePath({ source: src, targetDir, cut: true })
        .then(({ dest }) => syncFilePanelFilePath(src, dest)),
    ),
  ).then((res) => {
    const failed = res.filter((r) => r.status === "rejected").length;
    if (failed) toast.error(`Failed to move ${failed} item(s)`);
    // A move changes TWO dirs (source + target); watch events are partial/racy,
    // so reconcile both ends deterministically — otherwise the moved item
    // lingers in its old directory.
    const dirs = new Set<string>([targetDir]);
    for (const src of paths) dirs.add(src.slice(0, src.lastIndexOf("/")));
    for (const d of dirs) reloadDir(d);
  });
}

// ─── Rename / create ─────────────────────────────────────────────────────
const renamingPath = ref<string | null>(null);
const renameValue = ref("");
const pendingCreate = ref<{ parentDir: string; isDir: boolean; tempPath: string } | null>(null);

async function newEntry(type: "file" | "dir", atRoot = false) {
  let parentDir = props.workingDir;
  if (!atRoot) {
    const sel = [...model.selected.value];
    if (sel.length === 1) {
      const n = model.nodes.value.get(sel[0]);
      if (n) parentDir = n.isDir ? n.path : n.parentPath;
    }
  }
  if (parentDir !== props.workingDir && model.nodes.value.has(parentDir)) {
    await model.expand(parentDir); // ensure visible
  }
  const tempPath = model.addPlaceholder(parentDir, type === "dir");
  pendingCreate.value = { parentDir, isDir: type === "dir", tempPath };
  renamingPath.value = tempPath;
  renameValue.value = "";
}

async function commitRename() {
  const name = renameValue.value.trim();
  const rpc = useRpc();
  // --- create flow ---
  if (pendingCreate.value) {
    const { parentDir, isDir, tempPath } = pendingCreate.value;
    pendingCreate.value = null;
    renamingPath.value = null;
    model.removePlaceholder(tempPath);
    if (!name) return;
    const absDest = `${parentDir}/${name}`;
    try {
      await (isDir ? rpc.request.createDir({ path: absDest }) : rpc.request.createFile({ path: absDest }));
      if (!isDir) emit("openFile", absDest, true);
      // The create/rename backend commands don't emit directory-changed (and the
      // watcher is root-only), so reconcile the affected dir explicitly.
      await reloadDir(parentDir);
    } catch (e) {
      toast.error(`Failed to create: ${String(e)}`);
    }
    return;
  }
  // --- rename flow ---
  const path = renamingPath.value;
  renamingPath.value = null;
  if (!path || !name) return;
  const node = model.nodes.value.get(path);
  if (!node || name === node.name) return;
  const absDst = `${node.parentPath}/${name}`;
  try {
    await rpc.request.renamePath({ oldPath: path, newPath: absDst });
    syncFilePanelFilePath(path, absDst);
    emit("fileRenamed", path, absDst);
    await reloadDir(node.parentPath);
  } catch (e) {
    toast.error(`Failed to rename: ${String(e)}`);
  }
}

function cancelRename() {
  if (pendingCreate.value) {
    model.removePlaceholder(pendingCreate.value.tempPath);
    pendingCreate.value = null;
  }
  renamingPath.value = null;
  renameValue.value = "";
}

// ─── Context menu ────────────────────────────────────────────────────────
function startRename(node: TreeNode) {
  renamingPath.value = node.path;
  renameValue.value = node.name;
}

function onContextMenu(node: TreeNode, e: MouseEvent) {
  menuItem.value = node;
  menuX.value = e.clientX;
  menuY.value = e.clientY;
  if (!model.selected.value.has(node.path)) {
    model.selected.value = new Set([node.path]);
    model.triggerNodes();
  }
  menuOpen.value = true;
}

function collapseAll() { model.collapseAll(); scheduleSaveExpanded(); }
function handleMenuOpenChange(open: boolean) {
  if (open) return;
  menuOpen.value = false;
  menuItem.value = null;
}

function menuAction(action: string) {
  const node = menuItem.value;
  if (!node) return;
  const abs = node.path;
  const rpc = useRpc();
  switch (action) {
    case "open":
      if (!node.isDir) emit("openFile", abs, true);
      break;
    case "rename":
      startRename(node);
      break;
    case "delete":
      rpc.request.trashFile({ path: abs })
        .then(() => emit("fileDeleted", abs))
        .catch((e: unknown) => toast.error(String(e)));
      break;
    case "copy-path":
      navigator.clipboard.writeText(abs);
      break;
    case "copy-relative-path":
      navigator.clipboard.writeText(
        abs.startsWith(props.workingDir + "/") ? abs.slice(props.workingDir.length + 1) : abs,
      );
      break;
    case "reveal":
      rpc.request.revealInFinder({ path: abs });
      break;
  }
}

// ─── ⌘N — new file at root ───────────────────────────────────────────────
// The event can fire while we're mid-mount (buildTree is async) — defer until
// the tree exists rather than dropping it.
let treeReady = false;
let pendingNewFile = false;
function handleExplorerNewFile() {
  if (!treeReady) { pendingNewFile = true; return; }
  newEntry("file", true);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────
// Rebuild only when the exclude globs change (server computes per-entry
// isIgnored from them) — not on every settings-changed broadcast, which would
// also rebuild the tree on unrelated editor toggles. update()/load() replace
// the whole settings object, so filesExclude gets a fresh reference on every
// change; compare a content snapshot so this fires on content change only.
// Keys sorted because the server map (Rust HashMap) serializes in arbitrary
// order, which would otherwise produce spurious diffs.
const { settings } = useSettings();
function excludeSnapshot(): string {
  const map = settings.value.filesExclude ?? {};
  return Object.keys(map).sort().map((k) => `${k}=${map[k]}`).join("\n");
}
watch(excludeSnapshot, () => buildTree());
watch(() => props.workingDir, async () => { await buildTree(); await startWatching(props.workingDir); });
onMounted(async () => {
  // Register before the async build so a new-file event dispatched during the
  // same mount flush isn't missed.
  window.addEventListener("explorer-new-file", handleExplorerNewFile);
  await buildTree();
  await startWatching(props.workingDir);
  treeReady = true;
  if (pendingNewFile) { pendingNewFile = false; newEntry("file", true); }
});
onBeforeUnmount(() => {
  if (saveExpandedTimer) { clearTimeout(saveExpandedTimer); persistExpanded(); }
  if (saveScrollTimer) clearTimeout(saveScrollTimer);
  clearSpring();
  if (unlistenDir) unlistenDir();
  if (watchedDir) useRpc().request.unwatchDirectory({ path: watchedDir }).catch(() => {});
  window.removeEventListener("explorer-new-file", handleExplorerNewFile);
});
</script>

<template>
  <TooltipProvider :delay-duration="250">
    <div class="flex h-full flex-col" tabindex="-1">
      <div class="flex items-center justify-between gap-2 px-2 py-1 text-muted-foreground">
        <div class="min-w-0 truncate px-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {{ directoryName }}
        </div>
        <div class="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button size="icon-xs" variant="ghost" class="text-muted-foreground hover:text-foreground" @click="newEntry('file')">
                <FilePlusCorner class="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New File</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button size="icon-xs" variant="ghost" class="text-muted-foreground hover:text-foreground" @click="newEntry('dir')">
                <FolderPlus class="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New Folder</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button size="icon-xs" variant="ghost" class="text-muted-foreground hover:text-foreground" @click="collapseAll">
                <CopyMinus class="size-3.5 -scale-x-100" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Collapse All</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <FileTreeView
        ref="view"
        :rows="visibleRows"
        :selected="model.selected.value"
        :renaming-path="renamingPath"
        :rename-value="renameValue"
        :drag-over-dir="dragOverDir"
        class="min-h-0 flex-1"
        @row-click="onRowClick"
        @row-dbl-click="onRowDblClick"
        @toggle="onToggle"
        @contextmenu="onContextMenu"
        @update:rename-value="(v) => (renameValue = v)"
        @commit-rename="commitRename"
        @cancel-rename="cancelRename"
        @scroll="onScroll"
        @keydown="onKeydown"
        @dragstart="onRowDragStart"
        @dragover="onRowDragOver"
        @dragend="onRowDragEnd"
        @drop="onRowDrop"
      />
      <DropdownMenu :open="menuOpen" @update:open="handleMenuOpenChange">
        <DropdownMenuTrigger as-child>
          <div
            aria-hidden="true"
            class="pointer-events-none fixed"
            :style="{ left: `${menuX}px`, top: `${menuY}px`, width: '1px', height: '1px' }"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          data-file-tree-context-menu-root="true"
          class="min-w-[180px]"
          @close-auto-focus="(e: Event) => e.preventDefault()"
        >
          <DropdownMenuItem v-if="menuItem && !menuItem.isDir" @select="menuAction('open')">Open</DropdownMenuItem>
          <DropdownMenuItem @select="menuAction('rename')">Rename</DropdownMenuItem>
          <DropdownMenuItem @select="menuAction('delete')">Delete</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="menuAction('copy-path')">Copy Path</DropdownMenuItem>
          <DropdownMenuItem @select="menuAction('copy-relative-path')">Copy Relative Path</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="menuAction('reveal')">Reveal in Finder</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </TooltipProvider>
</template>
