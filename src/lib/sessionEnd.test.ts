import { describe, it, expect } from "vitest";
import { sessionEndAction, sessionEndLabel, shouldConfirmArchive } from "./sessionEnd";

describe("sessionEndAction", () => {
  it("archives a live session (this replaces the old close-session action)", () => {
    expect(sessionEndAction({ archived: false, exited: false })).toBe("archive");
  });

  it("deletes once nothing is live", () => {
    expect(sessionEndAction({ archived: true, exited: false })).toBe("delete");
    expect(sessionEndAction({ archived: false, exited: true })).toBe("delete");
    expect(sessionEndAction({ archived: true, exited: true })).toBe("delete");
  });
});

describe("sessionEndLabel", () => {
  it("labels each action in Title Case", () => {
    expect(sessionEndLabel("archive")).toBe("Archive Session");
    expect(sessionEndLabel("delete")).toBe("Delete Session");
  });
});

describe("shouldConfirmArchive", () => {
  it("confirms only while the agent is mid-work", () => {
    expect(shouldConfirmArchive("working")).toBe(true);
    expect(shouldConfirmArchive("blocked")).toBe(true);
    expect(shouldConfirmArchive("idle")).toBe(false);
    expect(shouldConfirmArchive("unknown")).toBe(false);
    expect(shouldConfirmArchive(undefined)).toBe(false);
  });
});
