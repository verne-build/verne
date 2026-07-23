import { describe, expect, it } from "vitest";
import { moveTabBetweenBuckets } from "./scopeMove";
import type { Tab } from "@/types";

const t = (id: string, directoryId: string): Tab =>
  ({ id, directoryId, label: id, cwd: "/a", sortOrder: 0, createdAt: 0 }) as Tab;

describe("moveTabBetweenBuckets", () => {
  it("moves, appends, updates directoryId+cwd", () => {
    const out = moveTabBetweenBuckets({ d1: [t("t1", "d1")], d2: [t("t2", "d2")] }, "t1", "d1", "d2", "/wt");
    expect(out.d1).toEqual([]);
    expect(out.d2.map((x) => x.id)).toEqual(["t2", "t1"]);
    expect(out.d2[1]).toMatchObject({ directoryId: "d2", cwd: "/wt" });
  });
  it("no-op when tab absent", () => {
    const buckets = { d1: [t("t1", "d1")] };
    expect(moveTabBetweenBuckets(buckets, "tX", "d1", "d2", "/wt")).toEqual(buckets);
  });
});
