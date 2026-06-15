import { ref, computed, shallowRef, triggerRef } from "vue";
import { useRpc } from "@/composables/useRpc";
import type { TreeEntry } from "@/types/shared"; // { name, path, isDir, isIgnored? } (camelCase)

export const PLACEHOLDER_SUFFIX = " new"; // unlikely to collide with a real path

export interface TreeNode {
  path: string;        // absolute
  name: string;
  isDir: boolean;
  isIgnored: boolean;
  depth: number;       // root children = 0
  parentPath: string;  // absolute; "" for root children
  childPaths: string[] | null; // null = not loaded
  expanded: boolean;
}

export function useFileTreeModel(rootDir: () => string) {
  // path -> node. shallowRef + manual trigger: we mutate the Map in place and
  // recompute visibleRows explicitly, never deep-react on every node.
  const nodes = shallowRef(new Map<string, TreeNode>());
  const rootChildren = ref<string[]>([]);
  const selected = ref(new Set<string>());
  const version = ref(0); // bump to recompute visibleRows after in-place edits

  function bump() { version.value++; }

  function entryToNode(e: TreeEntry, depth: number, parentPath: string): TreeNode {
    return {
      path: e.path, name: e.name, isDir: e.isDir, isIgnored: e.isIgnored ?? false,
      depth, parentPath, childPaths: null, expanded: false,
    };
  }

  async function loadDir(absPath: string, depth: number): Promise<string[]> {
    const genRoot = rootDir();
    const { entries } = await useRpc().request.listTree({ dir: absPath });
    // Workspace switched mid-load: drop the stale result so it can't pollute the
    // new tree's map.
    if (rootDir() !== genRoot) return [];
    const map = nodes.value;
    const childPaths: string[] = [];
    for (const e of entries) {
      childPaths.push(e.path);
      const existing = map.get(e.path);
      if (existing) {
        existing.isIgnored = e.isIgnored ?? false; // refresh flag, keep expansion/children
      } else {
        map.set(e.path, entryToNode(e, depth, absPath));
      }
    }
    return childPaths;
  }

  async function loadRoot(): Promise<void> {
    nodes.value = new Map();
    rootChildren.value = await loadDir(rootDir(), 0);
    bump();
  }

  async function expand(absPath: string): Promise<void> {
    const n = nodes.value.get(absPath);
    if (!n || !n.isDir) return;
    if (n.childPaths === null) {
      n.childPaths = await loadDir(absPath, n.depth + 1);
    }
    n.expanded = true;
    bump();
  }

  function collapse(absPath: string): void {
    const n = nodes.value.get(absPath);
    if (n) { n.expanded = false; bump(); }
  }

  async function toggle(absPath: string): Promise<void> {
    const n = nodes.value.get(absPath);
    if (!n) return;
    n.expanded ? collapse(absPath) : await expand(absPath);
  }

  function collapseAll(): void {
    for (const n of nodes.value.values()) n.expanded = false;
    bump();
  }

  // Flat list of currently-visible rows (DFS over expanded+loaded nodes).
  const visibleRows = computed<TreeNode[]>(() => {
    void version.value;
    const out: TreeNode[] = [];
    const map = nodes.value;
    const walk = (paths: string[]) => {
      for (const p of paths) {
        const n = map.get(p);
        if (!n) continue;
        out.push(n);
        if (n.isDir && n.expanded && n.childPaths) walk(n.childPaths);
      }
    };
    walk(rootChildren.value);
    return out;
  });

  // Insert a transient empty node at the FRONT of parentDir's children (parentDir
  // === rootDir() targets the root list). Returns the placeholder's path.
  function addPlaceholder(parentDir: string, isDir: boolean): string {
    const tempPath = `${parentDir}/${PLACEHOLDER_SUFFIX}`;
    const isRoot = parentDir === rootDir();
    const depth = isRoot ? 0 : (nodes.value.get(parentDir)?.depth ?? -1) + 1;
    nodes.value.set(tempPath, {
      path: tempPath, name: "", isDir, isIgnored: false,
      depth, parentPath: parentDir, childPaths: null, expanded: false,
    });
    // Respect the dirs-first sort: a folder placeholder goes to the top of the
    // dirs; a file placeholder goes below all dirs (top of the files).
    const insertInto = (siblings: string[]): string[] => {
      let at: number;
      if (isDir) {
        at = 0;
      } else {
        const i = siblings.findIndex((p) => !nodes.value.get(p)?.isDir);
        at = i === -1 ? siblings.length : i;
      }
      const next = siblings.slice();
      next.splice(at, 0, tempPath);
      return next;
    };
    if (isRoot) {
      rootChildren.value = insertInto(rootChildren.value);
    } else {
      const p = nodes.value.get(parentDir);
      if (p) p.childPaths = insertInto(p.childPaths ?? []);
    }
    bump();
    return tempPath;
  }

  function removePlaceholder(tempPath: string): void {
    const n = nodes.value.get(tempPath);
    if (!n) return;
    nodes.value.delete(tempPath);
    if (n.parentPath === rootDir()) {
      rootChildren.value = rootChildren.value.filter((p) => p !== tempPath);
    } else {
      const p = nodes.value.get(n.parentPath);
      if (p && p.childPaths) p.childPaths = p.childPaths.filter((x) => x !== tempPath);
    }
    bump();
  }

  const expandedPaths = (): string[] => {
    const out: string[] = [];
    for (const n of nodes.value.values()) if (n.isDir && n.expanded) out.push(n.path);
    return out;
  };

  return {
    nodes, rootChildren, selected, visibleRows,
    loadRoot, loadDir, expand, collapse, toggle, collapseAll,
    addPlaceholder, removePlaceholder,
    expandedPaths, bump, triggerNodes: () => triggerRef(nodes),
  };
}
