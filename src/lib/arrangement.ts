import type { LayoutNode } from "@/types";
import {
  applySizes,
  collectPaneIds,
  firstLeaf,
  insertSplit,
  parseLayout,
  removeLeaf,
} from "@/lib/paneLayout";

// Per-scope center composition (spec: Selection model). Leaves are session ids
// (== tab ids). Version-gated so future shape changes can migrate.
export interface Arrangement {
  version: 1;
  layout: LayoutNode;
}

function isValidLayout(n: unknown): n is LayoutNode {
  if (!n || typeof n !== "object") return false;
  const o = n as Record<string, unknown>;
  if (typeof o.pane === "string") return true;
  return (
    (o.direction === "h" || o.direction === "v") &&
    Array.isArray(o.children) &&
    o.children.length > 0 &&
    o.children.every(isValidLayout) &&
    Array.isArray(o.sizes)
  );
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
      if (v && v.version === 1 && isValidLayout(v.layout)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeArrangementMap(map: Record<string, Arrangement>): string {
  return JSON.stringify(map);
}

export function insertIntoArrangement(
  arr: Arrangement | null,
  anchorSessionId: string | null,
  newSessionId: string,
  direction: "h" | "v",
  before: boolean,
): Arrangement {
  if (!arr || !anchorSessionId)
    return { version: 1, layout: { pane: newSessionId } };
  return {
    version: 1,
    layout: insertSplit(arr.layout, anchorSessionId, newSessionId, direction, before),
  };
}

export function removeFromArrangement(arr: Arrangement, sessionId: string): Arrangement | null {
  const layout = removeLeaf(arr.layout, sessionId);
  return layout ? { version: 1, layout } : null;
}

export function applyArrangementSizes(arr: Arrangement, key: string, sizes: number[]): Arrangement {
  return { version: 1, layout: applySizes(arr.layout, key, sizes) };
}

interface MigratableGroup {
  id: string;
  layout: string; // raw JSON (wire TabGroup form)
  activePaneId?: string;
  sortOrder: number;
  createdAt: number;
}

// One-time groups → sessions conversion (spec: Migration). Active group's tree
// becomes the scope arrangement (solo or split); non-active layouts discarded.
export function migrateGroupsToArrangements(
  groupsByDir: Record<string, MigratableGroup[]>,
  activeGroupIdByDir: Record<string, string | undefined>,
): {
  arrangements: Record<string, Arrangement>;
  focusedByDir: Record<string, string | undefined>;
  orderByDir: Record<string, string[]>;
} {
  const arrangements: Record<string, Arrangement> = {};
  const focusedByDir: Record<string, string | undefined> = {};
  const orderByDir: Record<string, string[]> = {};
  for (const [dirId, groups] of Object.entries(groupsByDir)) {
    const sorted = [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    const order: string[] = [];
    for (const g of sorted) order.push(...collectPaneIds(parseLayout(g.layout)));
    orderByDir[dirId] = order;
    const active = sorted.find((g) => g.id === activeGroupIdByDir[dirId]) ?? sorted[0];
    if (!active) continue;
    const layout = parseLayout(active.layout);
    arrangements[dirId] = { version: 1, layout };
    focusedByDir[dirId] = active.activePaneId ?? firstLeaf(layout);
  }
  return { arrangements, focusedByDir, orderByDir };
}
