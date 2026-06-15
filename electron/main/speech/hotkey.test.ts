import { describe, it, expect } from "vitest";
import { acceleratorMatches } from "./hotkey";

const base = { key: "e", meta: false, ctrl: false, alt: false, shift: false };

describe("acceleratorMatches", () => {
  it("matches CommandOrControl+E on mac (meta)", () => {
    expect(acceleratorMatches("CommandOrControl+E", { ...base, meta: true }, "darwin")).toBe(true);
  });
  it("matches CommandOrControl+E on linux (ctrl)", () => {
    expect(acceleratorMatches("CommandOrControl+E", { ...base, ctrl: true }, "linux")).toBe(true);
  });
  it("rejects ctrl on mac for CommandOrControl", () => {
    expect(acceleratorMatches("CommandOrControl+E", { ...base, ctrl: true }, "darwin")).toBe(false);
  });
  it("rejects when an extra modifier is present", () => {
    expect(
      acceleratorMatches("CommandOrControl+E", { ...base, meta: true, shift: true }, "darwin"),
    ).toBe(false);
  });
  it("rejects the wrong key", () => {
    expect(acceleratorMatches("CommandOrControl+E", { ...base, key: "r", meta: true }, "darwin")).toBe(
      false,
    );
  });
  it("matches a multi-modifier accelerator", () => {
    expect(
      acceleratorMatches("Alt+Shift+D", { key: "d", meta: false, ctrl: false, alt: true, shift: true }, "darwin"),
    ).toBe(true);
  });
});
