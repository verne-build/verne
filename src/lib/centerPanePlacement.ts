import { isCenterSessionPickerId } from "@/lib/centerSessionPicker";
import type { LayoutNode } from "@/types";

export interface CenterPanePlacement {
  paneId: string;
  scopeId: string;
  anchorId: string;
  focusedSessionId?: string;
  multi: boolean;
  reserveLeftOverlay: boolean;
  reserveRightOverlay: boolean;
}

export interface CenterPanePlacementOptions {
  scopeId: string;
  focusedSessionId?: string;
  reserveLeftOverlay?: boolean;
  reserveRightOverlay?: boolean;
}

export function centerPaneAnchorId(scopeId: string, paneId: string): string {
  return `center-pane:${scopeId}:${paneId}`;
}

function countLeaves(layout: LayoutNode): number {
  if ("pane" in layout) return 1;
  return layout.children.reduce((count, child) => count + countLeaves(child), 0);
}

export function deriveCenterPanePlacements(
  layout: LayoutNode,
  options: CenterPanePlacementOptions,
): CenterPanePlacement[] {
  const placements: CenterPanePlacement[] = [];
  const emitted = new Set<string>();
  const multi = countLeaves(layout) > 1;

  const visit = (
    node: LayoutNode,
    reserveLeftOverlay: boolean,
    reserveRightOverlay: boolean,
  ) => {
    if ("pane" in node) {
      if (isCenterSessionPickerId(node.pane)) return;
      if (emitted.has(node.pane)) {
        const message = `Duplicate center pane placement: ${node.pane}`;
        if (import.meta.env.DEV) throw new Error(message);
        console.error(message);
        return;
      }
      emitted.add(node.pane);
      placements.push({
        paneId: node.pane,
        scopeId: options.scopeId,
        anchorId: centerPaneAnchorId(options.scopeId, node.pane),
        ...(options.focusedSessionId === undefined ? {} : { focusedSessionId: options.focusedSessionId }),
        multi,
        reserveLeftOverlay,
        reserveRightOverlay,
      });
      return;
    }

    const last = node.children.length - 1;
    node.children.forEach((child, index) => {
      visit(
        child,
        reserveLeftOverlay && index === 0,
        reserveRightOverlay && (node.direction === "v" || index === last),
      );
    });
  };

  visit(layout, options.reserveLeftOverlay ?? false, options.reserveRightOverlay ?? false);
  return placements;
}
