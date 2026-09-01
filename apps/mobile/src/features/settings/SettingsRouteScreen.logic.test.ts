import { describe, expect, it } from "vite-plus/test";

import {
  formatMobileVersionLabel,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("formatMobileVersionLabel", () => {
  it("shows the independent mobile version and native build identifier", () => {
    expect(
      formatMobileVersionLabel({
        version: "0.1.0",
        buildVersion: "42",
        variant: "production",
      }),
    ).toBe("0.1.0 (42)");
  });

  it("keeps non-production variants visible and tolerates local builds", () => {
    expect(
      formatMobileVersionLabel({
        version: "0.1.0",
        buildVersion: null,
        variant: "development",
      }),
    ).toBe("0.1.0 · Development");
  });
});
