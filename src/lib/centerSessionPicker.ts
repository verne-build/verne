import type { Arrangement } from "@/lib/arrangement";
import { insertIntoArrangement } from "@/lib/arrangement";
import { isLeaf, type SplitDir } from "@/lib/paneLayout";
import type { LayoutNode } from "@/types";

const CENTER_SESSION_PICKER_PREFIX = "center-picker:";

export function newCenterSessionPickerId(): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${CENTER_SESSION_PICKER_PREFIX}${id}`;
}

export function isCenterSessionPickerId(id: string): boolean {
  return id.startsWith(CENTER_SESSION_PICKER_PREFIX);
}

export function containsCenterSessionPicker(layout: LayoutNode, id?: string): boolean {
  if (isLeaf(layout)) {
    return id ? layout.pane === id : isCenterSessionPickerId(layout.pane);
  }
  return layout.children.some((child) => containsCenterSessionPicker(child, id));
}

export function insertCenterSessionPicker(
  arrangement: Arrangement | null,
  anchorSessionId: string | null,
  pickerId: string,
  direction: SplitDir,
  before = false,
): Arrangement {
  return insertIntoArrangement(arrangement, anchorSessionId, pickerId, direction, before);
}

function replaceLeaf(layout: LayoutNode, pickerId: string, sessionId: string): [LayoutNode, boolean] {
  if (isLeaf(layout)) {
    return layout.pane === pickerId ? [{ pane: sessionId }, true] : [layout, false];
  }
  let replaced = false;
  const children = layout.children.map((child) => {
    const [next, didReplace] = replaceLeaf(child, pickerId, sessionId);
    replaced ||= didReplace;
    return next;
  });
  return [{ ...layout, children }, replaced];
}

export function replaceCenterSessionPicker(
  arrangement: Arrangement,
  pickerId: string,
  sessionId: string,
): Arrangement | null {
  const [layout, replaced] = replaceLeaf(arrangement.layout, pickerId, sessionId);
  return replaced ? { version: 1, layout } : null;
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return sizes.map(() => 100 / sizes.length);
  return sizes.map((size) => (size / total) * 100);
}

function filterLayout(
  layout: LayoutNode,
  shouldRemove: (paneId: string) => boolean,
): LayoutNode | null {
  if (isLeaf(layout)) return shouldRemove(layout.pane) ? null : layout;

  const kept: LayoutNode[] = [];
  const keptSizes: number[] = [];
  layout.children.forEach((child, index) => {
    const filtered = filterLayout(child, shouldRemove);
    if (!filtered) return;
    kept.push(filtered);
    keptSizes.push(layout.sizes[index] ?? 0);
  });

  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { direction: layout.direction, children: kept, sizes: normalizeSizes(keptSizes) };
}

export function removeCenterSessionPicker(
  arrangement: Arrangement,
  pickerId: string,
): Arrangement | null {
  const layout = filterLayout(arrangement.layout, (paneId) => paneId === pickerId);
  return layout ? { version: 1, layout } : null;
}

export function persistedCenterArrangement(arrangement: Arrangement): Arrangement | null {
  const layout = filterLayout(arrangement.layout, isCenterSessionPickerId);
  return layout ? { version: 1, layout } : null;
}
