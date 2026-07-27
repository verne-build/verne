import { describe, expect, it } from "vitest";
import {
  activateBottomTab,
  addBottomTab,
  bottomSurfaceKey,
  clampBottomHeight,
  closeBottomTabState,
  DEFAULT_BOTTOM_HEIGHT_PX,
  emptyBottomPanelState,
  isBottomSurface,
  MIN_BOTTOM_HEIGHT_PX,
  parseBottomPanelMap,
  parseBottomSurfaceKey,
  pruneBottomTabs,
  reorderBottomTabs,
  serializeBottomPanelMap,
} from "./bottomPanel";

describe("surface keys", () => {
  it("round-trips dir + bottom tab id", () => {
    const key = bottomSurfaceKey("dir-1", "bt-1");
    expect(isBottomSurface(key)).toBe(true);
    expect(parseBottomSurfaceKey(key)).toEqual({ dirId: "dir-1", bottomTabId: "bt-1" });
  });

  it("treats a bare directory id as the center surface", () => {
    expect(isBottomSurface("dir-1")).toBe(false);
    expect(parseBottomSurfaceKey("dir-1")).toBeNull();
  });

  it("rejects a malformed bottom key", () => {
    expect(parseBottomSurfaceKey("bottom:dir-1")).toBeNull();
    expect(parseBottomSurfaceKey("bottom:dir-1:")).toBeNull();
  });
});

describe("tab reducers", () => {
  it("adds and activates", () => {
    const s = addBottomTab(emptyBottomPanelState(), "bt-1");
    expect(s.tabs).toEqual(["bt-1"]);
    expect(s.activeTabId).toBe("bt-1");
    expect(s.height).toBe(DEFAULT_BOTTOM_HEIGHT_PX);
  });

  it("closing the active tab activates its right neighbour", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2", "bt-3"]) s = addBottomTab(s, id);
    s = activateBottomTab(s, "bt-2");
    s = closeBottomTabState(s, "bt-2");
    expect(s.tabs).toEqual(["bt-1", "bt-3"]);
    expect(s.activeTabId).toBe("bt-3");
  });

  it("closing the last tab activates its left neighbour", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2"]) s = addBottomTab(s, id);
    s = closeBottomTabState(s, "bt-2");
    expect(s.activeTabId).toBe("bt-1");
  });

  it("closing a non-active tab keeps the active one", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2"]) s = addBottomTab(s, id);
    s = closeBottomTabState(s, "bt-1");
    expect(s.activeTabId).toBe("bt-2");
  });

  it("closing the only tab clears the active id", () => {
    const s = closeBottomTabState(addBottomTab(emptyBottomPanelState(), "bt-1"), "bt-1");
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeUndefined();
  });

  it("reorders without touching the active id", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2", "bt-3"]) s = addBottomTab(s, id);
    s = activateBottomTab(s, "bt-1");
    s = reorderBottomTabs(s, 0, 2);
    expect(s.tabs).toEqual(["bt-2", "bt-3", "bt-1"]);
    expect(s.activeTabId).toBe("bt-1");
  });

  it("ignores out-of-range reorders", () => {
    const s = addBottomTab(emptyBottomPanelState(), "bt-1");
    expect(reorderBottomTabs(s, 0, 5).tabs).toEqual(["bt-1"]);
    expect(reorderBottomTabs(s, -1, 0).tabs).toEqual(["bt-1"]);
  });

  it("prunes dead tabs and re-activates a survivor", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2"]) s = addBottomTab(s, id);
    s = pruneBottomTabs(s, new Set(["bt-1"]));
    expect(s.tabs).toEqual(["bt-1"]);
    expect(s.activeTabId).toBe("bt-1");
  });

  it("activateBottomTab ignores unknown ids", () => {
    const s = activateBottomTab(addBottomTab(emptyBottomPanelState(), "bt-1"), "nope");
    expect(s.activeTabId).toBe("bt-1");
  });
});

describe("height + persistence", () => {
  it("clamps height to the minimum", () => {
    expect(clampBottomHeight(10)).toBe(MIN_BOTTOM_HEIGHT_PX);
    expect(clampBottomHeight(300)).toBe(300);
  });

  it("round-trips a map", () => {
    const map = { "dir-1": { tabs: ["bt-1"], activeTabId: "bt-1", height: 300, collapsed: true } };
    expect(parseBottomPanelMap(serializeBottomPanelMap(map))).toEqual(map);
  });

  it("drops malformed entries", () => {
    expect(parseBottomPanelMap('{"dir-1":{"tabs":"nope"}}')).toEqual({});
    expect(parseBottomPanelMap("not json")).toEqual({});
    expect(parseBottomPanelMap(null)).toEqual({});
  });

  it("normalises a stored entry with a bad height or dangling active id", () => {
    const parsed = parseBottomPanelMap(
      '{"dir-1":{"tabs":["bt-1"],"activeTabId":"gone","height":5,"collapsed":false}}',
    );
    expect(parsed["dir-1"].height).toBe(MIN_BOTTOM_HEIGHT_PX);
    expect(parsed["dir-1"].activeTabId).toBe("bt-1");
  });
});
