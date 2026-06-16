import { describe, expect, it } from "vitest";
import { updateToast } from "@/composables/useAppUpdates";

describe("updateToast", () => {
  it("checking + manual → loading spinner", () => {
    const r = updateToast({ kind: "checking", manual: true });
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ type: "loading", title: "Checking for updates…" });
  });

  it("checking without manual → null (silent)", () => {
    expect(updateToast({ kind: "checking", manual: false })).toBeNull();
  });

  it("available → loading toast with version", () => {
    const r = updateToast({ kind: "available", version: "1.2.3" });
    expect(r).toMatchObject({ type: "loading", title: "Update available" });
    expect((r as { opts: Record<string, unknown> }).opts.description).toContain("1.2.3");
  });

  it("progress < 100 → downloading with percent", () => {
    const r = updateToast({ kind: "progress", version: "1.2.3", percent: 42 });
    expect(r).toMatchObject({ type: "loading", title: "Downloading v1.2.3…" });
    expect((r as { opts: Record<string, unknown> }).opts.description).toBe("42%");
  });

  it("progress >= 100 → installing (covers verify/stage gap)", () => {
    const r = updateToast({ kind: "progress", version: "1.2.3", percent: 100 });
    expect(r).toMatchObject({ type: "loading", title: "Installing update…" });
  });

  it("all phases share one stable toast id", () => {
    for (const e of [
      { kind: "checking", manual: true },
      { kind: "available", version: "1.2.3" },
      { kind: "progress", version: "1.2.3", percent: 10 },
      { kind: "downloaded", version: "1.2.3" },
    ] as const) {
      const r = updateToast(e) as { opts: Record<string, unknown> };
      expect(r.opts.id).toBe("app-update");
    }
  });

  it("not-available + manual → up to date toast", () => {
    const r = updateToast({ kind: "not-available", manual: true });
    expect(r).toMatchObject({ type: "success", title: "You're up to date" });
  });

  it("not-available without manual → dismiss (silent)", () => {
    expect(updateToast({ kind: "not-available", manual: false })).toEqual({ type: "dismiss" });
  });

  it("downloaded → success toast with restart action", () => {
    const r = updateToast({ kind: "downloaded", version: "1.2.3" }) as { opts: Record<string, unknown> };
    expect(r.opts.duration).toBe(Infinity);
    expect((r.opts.action as { label: string }).label).toBe("Restart to Update");
  });

  it("error + manual → error toast", () => {
    const r = updateToast({ kind: "error", manual: true, message: "oops" });
    expect(r).toMatchObject({ type: "error", title: "Update check failed" });
  });

  it("error without manual → dismiss (logged, not toasted)", () => {
    expect(updateToast({ kind: "error", manual: false, message: "oops" })).toEqual({ type: "dismiss" });
  });
});
