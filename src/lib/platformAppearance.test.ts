// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { applyPlatformAppearance, isMacPlatform } from "./platformAppearance";

describe("isMacPlatform", () => {
  it("prefers userAgentData when Chromium provides it", () => {
    expect(isMacPlatform({ userAgentData: { platform: "macOS" }, platform: "Linux x86_64" })).toBe(true);
  });

  it("falls back to navigator.platform", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
  });

  it("rejects non-macOS platforms", () => {
    expect(isMacPlatform({ userAgentData: { platform: "Linux" }, platform: "MacIntel" })).toBe(false);
  });
});

describe("applyPlatformAppearance", () => {
  it("makes the macOS document canvas transparent", () => {
    applyPlatformAppearance(document, { platform: "MacIntel" });

    expect(document.documentElement.classList.contains("macos-vibrancy")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("background")).toBe("transparent");
    expect(document.documentElement.style.getPropertyPriority("background")).toBe("important");
    expect(document.body.style.getPropertyValue("background")).toBe("transparent");
    expect(document.body.style.getPropertyPriority("background")).toBe("important");
  });

  it("leaves non-macOS document backgrounds unchanged", () => {
    document.documentElement.classList.remove("macos-vibrancy");
    document.documentElement.style.removeProperty("background");
    document.body.style.removeProperty("background");

    applyPlatformAppearance(document, { platform: "Linux x86_64" });

    expect(document.documentElement.classList.contains("macos-vibrancy")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("background")).toBe("");
    expect(document.body.style.getPropertyValue("background")).toBe("");
  });
});
