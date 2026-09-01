import { describe, expect, it } from "vite-plus/test";

import upstreamFixture from "../../../config/verne-upstream.json" with { type: "json" };
import {
  decodeUpstreamProvenance,
  formatBuildIdentity,
  requireBuildRevision,
  resolveBuildRevision,
} from "./releaseIdentity.ts";

describe("Verne release identity", () => {
  it("decodes the committed T3 Code synchronization boundary", () => {
    expect(decodeUpstreamProvenance(upstreamFixture)).toEqual({
      schemaVersion: 1,
      product: "T3 Code",
      repository: "pingdotgg/t3code",
      version: "0.0.37",
      revision: "b883fc066ea5c9bebbe1c3e9b4bc2471aab3685f",
    });
  });

  it("rejects provenance that cannot identify one exact upstream commit", () => {
    expect(() =>
      decodeUpstreamProvenance({
        ...upstreamFixture,
        revision: "b883fc0",
      }),
    ).toThrow();
  });

  it("prefers an explicit exact Verne revision and then the GitHub revision", () => {
    expect(
      resolveBuildRevision({
        explicitRevision: "0123456789abcdef0123456789abcdef01234567",
        githubRevision: "89abcdef0123456789abcdef0123456789abcdef",
      }),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(
      resolveBuildRevision({
        explicitRevision: "dirty",
        githubRevision: "89abcdef0123456789abcdef0123456789abcdef",
      }),
    ).toBe("89abcdef0123456789abcdef0123456789abcdef");
    expect(resolveBuildRevision({ explicitRevision: "dirty", githubRevision: "short" })).toBe(
      "unknown",
    );
  });

  it("rejects publishable builds without an exact Verne revision", () => {
    expect(() => requireBuildRevision({ explicitRevision: "dirty" })).toThrow(
      "Publishable Verne builds require a full Git revision",
    );
    expect(
      requireBuildRevision({
        explicitRevision: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("formats Verne first and upstream provenance as secondary diagnostics", () => {
    expect(
      formatBuildIdentity({
        product: "Verne",
        version: "0.2.0",
        revision: "0123456789abcdef0123456789abcdef01234567",
        upstream: decodeUpstreamProvenance(upstreamFixture),
      }),
    ).toBe(
      [
        "Verne version: 0.2.0",
        "Verne revision: 0123456",
        "Based on T3 Code 0.0.37",
        "T3 Code revision: b883fc0",
      ].join("\n"),
    );
  });
});
