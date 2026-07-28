// Row model for the bottom panel's terminal list. A solo group is one row; a
// split group is its row plus one indented row per pane, in layout order.
import { collectPaneIds, isLeaf } from "@/lib/paneLayout";
import type { LayoutNode } from "@/types";

/** The bottom panel is side-by-side only (see AGENTS.md / task 5): rewrite
 *  every "v" direction to "h" when reading a bottom surface's layout for
 *  render. Persisted state is untouched — this only affects what's shown. */
export function toHorizontal(node: LayoutNode): LayoutNode {
  if (isLeaf(node)) return node;
  return { direction: "h", children: node.children.map(toHorizontal), sizes: node.sizes };
}

export interface BottomListRow {
  kind: "group" | "pane";
  groupId: string;
  /** Group rows carry their PRIMARY pane (first leaf) — a stable identity that
   *  doesn't change as focus moves within a split. */
  paneId: string;
  depth: 0 | 1;
}

export function bottomListRows(
  groupIds: readonly string[],
  layoutFor: (groupId: string) => LayoutNode | null,
): BottomListRow[] {
  const rows: BottomListRow[] = [];
  for (const groupId of groupIds) {
    const layout = layoutFor(groupId);
    if (!layout) continue; // pruned mid-render; the list just skips it
    const panes = collectPaneIds(layout);
    if (!panes.length) continue;
    rows.push({ kind: "group", groupId, paneId: panes[0], depth: 0 });
    if (panes.length > 1)
      for (const paneId of panes) rows.push({ kind: "pane", groupId, paneId, depth: 1 });
  }
  return rows;
}
