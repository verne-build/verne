import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { parseSemver } from "@t3tools/shared/semver";
import { releasePackageFiles } from "./update-release-package-versions.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

describe("Verne release baseline", () => {
  it("keeps every coordinated core manifest on one valid version", () => {
    expect(releasePackageFiles).toEqual([
      "apps/server/package.json",
      "apps/desktop/package.json",
      "apps/web/package.json",
      "packages/contracts/package.json",
    ]);
    const versions = releasePackageFiles.map((relativePath) => {
      const packageJson = JSON.parse(
        NodeFS.readFileSync(NodePath.join(repoRoot, relativePath), "utf8"),
      ) as { readonly version?: unknown };
      return packageJson.version;
    });
    expect(new Set(versions).size).toBe(1);
    expect(typeof versions[0] === "string" ? parseSemver(versions[0]) : null).not.toBeNull();
  });
});
