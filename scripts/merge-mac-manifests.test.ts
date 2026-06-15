import { describe, expect, it } from "vitest";
import { mergeManifests } from "./merge-mac-manifests.mjs";

const ARM = `version: 0.2.0
files:
  - url: Verne-0.2.0-arm64-mac.zip
    sha512: AAA
    size: 100
path: Verne-0.2.0-arm64-mac.zip
sha512: AAA
releaseDate: '2026-06-14T10:00:00.000Z'
`;
const X64 = `version: 0.2.0
files:
  - url: Verne-0.2.0-mac.zip
    sha512: CCC
    size: 110
path: Verne-0.2.0-mac.zip
sha512: CCC
releaseDate: '2026-06-14T10:05:00.000Z'
`;

describe("mergeManifests", () => {
  it("unions both arch zips into one files list", async () => {
    const yaml = (await import("js-yaml")).default;
    const merged = yaml.load(mergeManifests([ARM, X64])) as {
      version: string; files: { url: string }[]; releaseDate: string;
    };
    expect(merged.version).toBe("0.2.0");
    const urls = merged.files.map((f) => f.url);
    expect(urls).toContain("Verne-0.2.0-arm64-mac.zip");
    expect(urls).toContain("Verne-0.2.0-mac.zip");
    expect(merged.files).toHaveLength(2);
    expect(merged.releaseDate).toBe("2026-06-14T10:05:00.000Z");
  });

  it("dedups repeated urls", () => {
    const merged = mergeManifests([ARM, ARM]);
    expect((merged.match(/Verne-0.2.0-arm64-mac.zip/g) ?? []).length).toBe(2);
  });
});
