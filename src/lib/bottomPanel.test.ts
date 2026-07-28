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
  groupNumber,
  groupName,
  setGroupName,
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
    const map = {
      "dir-1": {
        tabs: ["bt-1"],
        activeTabId: "bt-1",
        height: 300,
        collapsed: true,
        numbers: { "bt-1": 1 },
        names: {},
      },
    };
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

describe("group numbers", () => {
  it("assigns 1 to the first group", () => {
    const s = addBottomTab(emptyBottomPanelState(), "bt-1");
    expect(groupNumber(s, "bt-1")).toBe(1);
  });

  it("numbers each new group above the highest in use", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2", "bt-3"]) s = addBottomTab(s, id);
    expect([1, 2, 3].map((_, i) => groupNumber(s, `bt-${i + 1}`))).toEqual([1, 2, 3]);
  });

  it("keeps existing numbers when a group closes — no renumbering", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2", "bt-3"]) s = addBottomTab(s, id);
    s = closeBottomTabState(s, "bt-1");
    expect(groupNumber(s, "bt-2")).toBe(2);
    expect(groupNumber(s, "bt-3")).toBe(3);
  });

  it("never reuses a closed group's number", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2"]) s = addBottomTab(s, id);
    s = closeBottomTabState(s, "bt-2");
    s = addBottomTab(s, "bt-3");
    expect(groupNumber(s, "bt-3")).toBe(3);
  });

  it("keeps numbers across a reorder", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2"]) s = addBottomTab(s, id);
    s = reorderBottomTabs(s, 0, 1);
    expect(s.tabs).toEqual(["bt-2", "bt-1"]);
    expect(groupNumber(s, "bt-1")).toBe(1);
  });

  it("drops numbers for pruned groups", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2"]) s = addBottomTab(s, id);
    s = pruneBottomTabs(s, new Set(["bt-1"]));
    expect(s.numbers).toEqual({ "bt-1": 1 });
  });

  it("backfills positional numbers for state persisted before numbering existed", () => {
    const parsed = parseBottomPanelMap(
      '{"dir-1":{"tabs":["bt-1","bt-2"],"activeTabId":"bt-1","height":260,"collapsed":false}}',
    );
    expect(parsed["dir-1"].numbers).toEqual({ "bt-1": 1, "bt-2": 2 });
  });

  it("round-trips numbers", () => {
    const map = {
      "dir-1": {
        tabs: ["bt-1"],
        activeTabId: "bt-1",
        height: 300,
        collapsed: false,
        numbers: { "bt-1": 7 },
        names: {},
      },
    };
    expect(parseBottomPanelMap(serializeBottomPanelMap(map))).toEqual(map);
  });
});

describe("group names", () => {
  it("has no name until one is set", () => {
    const s = addBottomTab(emptyBottomPanelState(), "bt-1");
    expect(groupName(s, "bt-1")).toBeUndefined();
  });

  it("stores a name against the group, not a pane", () => {
    const s = setGroupName(addBottomTab(emptyBottomPanelState(), "bt-1"), "bt-1", "build");
    expect(groupName(s, "bt-1")).toBe("build");
  });

  it("trims, and an empty name clears back to the default", () => {
    let s = setGroupName(addBottomTab(emptyBottomPanelState(), "bt-1"), "bt-1", "  build  ");
    expect(groupName(s, "bt-1")).toBe("build");
    s = setGroupName(s, "bt-1", "   ");
    expect(groupName(s, "bt-1")).toBeUndefined();
  });

  it("ignores an unknown group", () => {
    const s = setGroupName(addBottomTab(emptyBottomPanelState(), "bt-1"), "nope", "x");
    expect(s.names).toEqual({});
  });

  it("drops the name when the group closes", () => {
    let s = setGroupName(addBottomTab(emptyBottomPanelState(), "bt-1"), "bt-1", "build");
    s = closeBottomTabState(s, "bt-1");
    expect(s.names).toEqual({});
  });

  it("drops names for pruned groups", () => {
    let s = emptyBottomPanelState();
    for (const id of ["bt-1", "bt-2"]) s = addBottomTab(s, id);
    s = setGroupName(setGroupName(s, "bt-1", "a"), "bt-2", "b");
    s = pruneBottomTabs(s, new Set(["bt-2"]));
    expect(s.names).toEqual({ "bt-2": "b" });
  });

  it("round-trips names, and tolerates state saved before they existed", () => {
    const map = {
      "dir-1": {
        tabs: ["bt-1"],
        activeTabId: "bt-1",
        height: 260,
        collapsed: false,
        numbers: { "bt-1": 1 },
        names: { "bt-1": "build" },
      },
    };
    expect(parseBottomPanelMap(serializeBottomPanelMap(map))).toEqual(map);
    const legacy = parseBottomPanelMap(
      '{"dir-1":{"tabs":["bt-1"],"activeTabId":"bt-1","height":260,"collapsed":false,"numbers":{"bt-1":1}}}',
    );
    expect(legacy["dir-1"].names).toEqual({});
  });
});
