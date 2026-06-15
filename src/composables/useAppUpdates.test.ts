import { describe, expect, it } from "vitest";
import { updateToast } from "@/composables/useAppUpdates";

describe("updateToast", () => {
  it("available → toast", () => {
    const r = updateToast({ kind: "available", version: "1.2.3" });
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Update available");
    expect((r!.opts as Record<string, unknown>).description).toContain("1.2.3");
  });

  it("not-available + manual → up to date toast", () => {
    const r = updateToast({ kind: "not-available", manual: true });
    expect(r).not.toBeNull();
    expect(r!.title).toBe("You're up to date");
  });

  it("not-available without manual → null (silent)", () => {
    const r = updateToast({ kind: "not-available", manual: false });
    expect(r).toBeNull();
  });

  it("downloaded → non-auto-dismiss toast with restart action", () => {
    const r = updateToast({ kind: "downloaded", version: "1.2.3" });
    expect(r).not.toBeNull();
    const opts = r!.opts as Record<string, unknown>;
    expect(opts.duration).toBe(Infinity);
    const action = opts.action as { label: string };
    expect(action.label).toBe("Restart to Update");
  });

  it("error without manual → null (logged, not toasted)", () => {
    const r = updateToast({ kind: "error", manual: false, message: "oops" });
    expect(r).toBeNull();
  });
});
