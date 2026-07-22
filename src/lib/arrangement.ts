import type { LayoutNode } from "@/types";
import { collectPaneIds, removeLeaf } from "@/lib/paneLayout";

// Per-scope center composition (spec: Selection model). Leaves are session ids
// (== tab ids). Version-gated so future shape changes can migrate.
export interface Arrangement {
  version: 1;
  layout: LayoutNode;
}

export function deriveArrangement(layout: LayoutNode | undefined | null): Arrangement | null {
  return layout ? { version: 1, layout } : null;
}

// Drop leaves whose session no longer exists; null when nothing survives.
export function pruneArrangement(
  arr: Arrangement,
  liveSessionIds: ReadonlySet<string>,
): Arrangement | null {
  let layout: LayoutNode | null = arr.layout;
  for (const id of collectPaneIds(arr.layout)) {
    if (!liveSessionIds.has(id) && layout) layout = removeLeaf(layout, id);
  }
  return layout ? { version: 1, layout } : null;
}

export function parseArrangementMap(raw: string | null): Record<string, Arrangement> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, Arrangement | undefined>;
    const out: Record<string, Arrangement> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.version === 1 && v.layout) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeArrangementMap(map: Record<string, Arrangement>): string {
  return JSON.stringify(map);
}
