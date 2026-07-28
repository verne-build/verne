import { describe, expect, it } from "vitest";
import type { LayoutNode } from "@/types";
import {
  centerPaneAnchorId,
  deriveCenterPanePlacements,
} from "@/lib/centerPanePlacement";

describe("center pane placement", () => {
  it("places one session without overlay reservations", () => {
    expect(deriveCenterPanePlacements({ pane: "session-a" }, { scopeId: "dir-1" })).toEqual([
      {
        paneId: "session-a",
        scopeId: "dir-1",
        anchorId: "center-pane:dir-1:session-a",
        multi: false,
        reserveLeftOverlay: false,
        reserveRightOverlay: false,
      },
    ]);
  });

  it("places session leaves depth-first around a picker split", () => {
    const picker = "center-picker:test";
    const layout: LayoutNode = {
      direction: "h",
      children: [
        { pane: "session-a" },
        {
          direction: "v",
          children: [{ pane: picker }, { pane: "session-b" }],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    };

    expect(deriveCenterPanePlacements(layout, {
      scopeId: "dir-1",
      focusedSessionId: "session-b",
      reserveLeftOverlay: true,
      reserveRightOverlay: true,
    })).toEqual([
      {
        paneId: "session-a",
        scopeId: "dir-1",
        anchorId: "center-pane:dir-1:session-a",
        focusedSessionId: "session-b",
        multi: true,
        reserveLeftOverlay: true,
        reserveRightOverlay: false,
      },
      {
        paneId: "session-b",
        scopeId: "dir-1",
        anchorId: "center-pane:dir-1:session-b",
        focusedSessionId: "session-b",
        multi: true,
        reserveLeftOverlay: false,
        reserveRightOverlay: true,
      },
    ]);
  });

  it("keeps placement order and anchor ids when only split sizes change", () => {
    const first: LayoutNode = {
      direction: "h",
      children: [{ pane: "session-a" }, { pane: "session-b" }],
      sizes: [50, 50],
    };
    const resized: LayoutNode = { ...first, sizes: [20, 80] };

    expect(deriveCenterPanePlacements(resized, { scopeId: "dir-1" })).toEqual(
      deriveCenterPanePlacements(first, { scopeId: "dir-1" }),
    );
  });

  it("propagates the reserved right edge through every vertical child", () => {
    const layout: LayoutNode = {
      direction: "v",
      children: [{ pane: "session-a" }, { pane: "session-b" }],
      sizes: [50, 50],
    };

    expect(deriveCenterPanePlacements(layout, {
      scopeId: "dir-1",
      reserveRightOverlay: true,
    })).toEqual([
      {
        paneId: "session-a",
        scopeId: "dir-1",
        anchorId: "center-pane:dir-1:session-a",
        multi: true,
        reserveLeftOverlay: false,
        reserveRightOverlay: true,
      },
      {
        paneId: "session-b",
        scopeId: "dir-1",
        anchorId: "center-pane:dir-1:session-b",
        multi: true,
        reserveLeftOverlay: false,
        reserveRightOverlay: true,
      },
    ]);
  });

  it("keeps before and after leaves in depth-first order through nested splits", () => {
    const layout: LayoutNode = {
      direction: "h",
      children: [
        {
          direction: "v",
          children: [{ pane: "session-before" }, { pane: "session-middle" }],
          sizes: [50, 50],
        },
        { pane: "session-after" },
      ],
      sizes: [60, 40],
    };

    expect(deriveCenterPanePlacements(layout, { scopeId: "dir-1" }).map(({ paneId }) => paneId)).toEqual([
      "session-before",
      "session-middle",
      "session-after",
    ]);
  });

  it("throws for duplicate session leaves in development", () => {
    const layout: LayoutNode = {
      direction: "h",
      children: [{ pane: "session-a" }, { pane: "session-a" }],
      sizes: [50, 50],
    };

    expect(() => deriveCenterPanePlacements(layout, { scopeId: "dir-1" }))
      .toThrow("Duplicate center pane placement: session-a");
  });

  it("builds unescaped anchors from the scope and pane ids", () => {
    expect(centerPaneAnchorId("dir:1", "session/a")).toBe("center-pane:dir:1:session/a");
  });
});
