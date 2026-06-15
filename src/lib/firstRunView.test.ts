import { describe, expect, it } from "vitest";
import { firstRunView } from "@/lib/firstRunView";

const base = { directoriesLoaded: true, directoryCount: 0, hasSelection: false, welcomeSeen: false };

describe("firstRunView", () => {
  it("returns 'none' when a workspace is selected", () => {
    expect(firstRunView({ ...base, hasSelection: true })).toBe("none");
    expect(firstRunView({ ...base, hasSelection: true, directoryCount: 3 })).toBe("none");
  });

  it("returns 'none' before directories have loaded (no flash)", () => {
    expect(firstRunView({ ...base, directoriesLoaded: false })).toBe("none");
  });

  it("returns 'hero' on a true first run (loaded, empty, unseen)", () => {
    expect(firstRunView(base)).toBe("hero");
  });

  it("returns 'picker' once welcome has been seen, even with zero directories", () => {
    expect(firstRunView({ ...base, welcomeSeen: true })).toBe("picker");
  });

  it("returns 'picker' when directories exist but none selected", () => {
    expect(firstRunView({ ...base, directoryCount: 2 })).toBe("picker");
    expect(firstRunView({ ...base, directoryCount: 2, welcomeSeen: true })).toBe("picker");
  });
});
