import type { LayoutNode } from "@/types";

export type SplitDir = "h" | "v";

export function isLeaf(n: LayoutNode): n is { pane: string } {
  return "pane" in n;
}

/** First pane id in depth-first order. */
export function firstLeaf(n: LayoutNode): string {
  return isLeaf(n) ? n.pane : firstLeaf(n.children[0]);
}

/** All pane ids in depth-first order. */
export function collectPaneIds(n: LayoutNode, out: string[] = []): string[] {
  if (isLeaf(n)) out.push(n.pane);
  else for (const c of n.children) collectPaneIds(c, out);
  return out;
}

export function paneCount(n: LayoutNode): number {
  return collectPaneIds(n).length;
}

/** Which tabs to resize to the viewport when a full-area terminal reports its
 *  grid size. The reporter must itself be a single pane (so its container equals
 *  the whole viewport); then every OTHER single-pane group's tab is a target
 *  (it'll occupy that same full area when shown). Split groups are excluded —
 *  their panes are sized individually on activation. Returns [] if the reporter
 *  isn't a single-pane group. */
export function singlePaneResizeTargets(layouts: LayoutNode[], reporterTabId: string): string[] {
  const single = (n: LayoutNode): string | null => {
    const ids = collectPaneIds(n);
    return ids.length === 1 ? ids[0] : null;
  };
  if (!layouts.some((l) => single(l) === reporterTabId)) return [];
  const targets: string[] = [];
  for (const l of layouts) {
    const id = single(l);
    if (id && id !== reporterTabId) targets.push(id);
  }
  return targets;
}

function clone(n: LayoutNode): LayoutNode {
  return isLeaf(n)
    ? { pane: n.pane }
    : { direction: n.direction, children: n.children.map(clone), sizes: [...n.sizes] };
}

function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}

/** Insert `newPane` adjacent to `targetPane`, splitting in `dir`. If the target's
 *  parent already splits in `dir`, the pane is added as a sibling (avoids needless
 *  nesting, VS Code-style); otherwise the leaf becomes a 2-child split node.
 *  `before` inserts the new pane ahead of the target. Returns a new tree. */
export function insertSplit(
  root: LayoutNode,
  targetPane: string,
  newPane: string,
  dir: SplitDir,
  before = false,
): LayoutNode {
  const rec = (n: LayoutNode, parentDir: SplitDir | null): LayoutNode => {
    if (isLeaf(n)) {
      if (n.pane !== targetPane) return n;
      // Parent already splits this way → caller handles sibling insertion.
      return {
        direction: dir,
        children: before ? [{ pane: newPane }, { pane: targetPane }] : [{ pane: targetPane }, { pane: newPane }],
        sizes: evenSizes(2),
      };
    }
    // Internal node: if a direct child is the target leaf and our direction
    // matches, splice the new pane in as a sibling.
    if (n.direction === dir) {
      const idx = n.children.findIndex((c) => isLeaf(c) && c.pane === targetPane);
      if (idx !== -1) {
        const children = [...n.children];
        children.splice(before ? idx : idx + 1, 0, { pane: newPane });
        return { direction: dir, children, sizes: evenSizes(children.length) };
      }
    }
    return { direction: n.direction, children: n.children.map((c) => rec(c, n.direction)), sizes: n.sizes };
  };
  return rec(clone(root), null);
}

/** Remove `pane` and collapse single-child nodes. Returns the new tree, or null
 *  if the pane was the whole tree (group should be deleted). */
export function removeLeaf(root: LayoutNode, pane: string): LayoutNode | null {
  if (isLeaf(root)) return root.pane === pane ? null : root;
  const rec = (n: LayoutNode): LayoutNode | null => {
    if (isLeaf(n)) return n.pane === pane ? null : n;
    const kept: LayoutNode[] = [];
    for (const c of n.children) {
      const r = rec(c);
      if (r) kept.push(r);
    }
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]; // collapse single child
    return { direction: n.direction, children: kept, sizes: evenSizes(kept.length) };
  };
  return rec(root);
}

/** A splitter node's stable identity: the first-leaf pane id of each direct
 *  child, joined. Used to locate which internal node a reka-ui group maps to. */
export function nodeKey(n: LayoutNode): string {
  return isLeaf(n) ? n.pane : n.children.map(firstLeaf).join("|");
}

/** Write resize percentages into the internal node identified by `key`
 *  (see `nodeKey`). Returns a new tree. */
export function applySizes(root: LayoutNode, key: string, sizes: number[]): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (isLeaf(n)) return n;
    const children = n.children.map(rec);
    if (nodeKey(n) === key && children.length === sizes.length) {
      return { direction: n.direction, children, sizes: [...sizes] };
    }
    return { direction: n.direction, children, sizes: n.sizes };
  };
  return rec(root);
}

export function parseLayout(raw: string): LayoutNode {
  try {
    return JSON.parse(raw) as LayoutNode;
  } catch {
    return { pane: raw };
  }
}
