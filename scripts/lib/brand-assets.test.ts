// @effect-diagnostics nodeBuiltinImport:off - Host-side asset assertions inspect tracked repository files directly.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("uses the current Verne development web icon for repository project cards", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
    const projectFile = JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, "t3.json"), "utf8"));

    expect(projectFile.iconPath).toBe("assets/verne/dev/verne-web-apple-touch-180.png");
  });

  it("maps production web assets into the server package", () => {
    expect(resolveWebIconOverrides("production", "dist/client")).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("maps development web assets to the public splash and favicon files", () => {
    expect(DEVELOPMENT_PUBLIC_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
        targetRelativePath: "apps/web/public/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
        targetRelativePath: "apps/web/public/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
        targetRelativePath: "apps/web/public/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
        targetRelativePath: "apps/web/public/apple-touch-icon.png",
      },
    ]);
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      targetRelativePath: "apps/web/dist/favicon.ico",
    });
  });

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });

  it("maps package versions to web asset brands", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("production");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("nightly");
  });

  it("routes every channel through independently replaceable Verne icon families", () => {
    expect([
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      BRAND_ASSET_PATHS.productionIconComposerProject,
    ]).toEqual([
      "assets/verne/dev/app-icon.icon",
      "assets/verne/nightly/app-icon.icon",
      "assets/verne/prod/app-icon.icon",
    ]);
    expect(BRAND_ASSET_PATHS.developmentDesktopIconPng).toMatch(/^assets\/verne\/dev\//);
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toMatch(/^assets\/verne\/nightly\//);
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toMatch(/^assets\/verne\/prod\//);
  });

  it("ships every referenced Verne raster asset and uses identical artwork for now", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
    const rasterPaths = Object.values(BRAND_ASSET_PATHS).filter(
      (path) => path.startsWith("assets/verne/") && !path.endsWith(".icon"),
    );

    for (const path of rasterPaths) {
      expect(NodeFS.existsSync(NodePath.join(repoRoot, path)), path).toBe(true);
    }

    for (const suffix of [
      "macos-1024.png",
      "universal-1024.png",
      "windows.ico",
      "web-favicon.ico",
      "web-favicon-16x16.png",
      "web-favicon-32x32.png",
      "web-apple-touch-180.png",
    ]) {
      const files = ["dev", "nightly", "prod"].map((channel) =>
        NodeFS.readFileSync(NodePath.join(repoRoot, `assets/verne/${channel}/verne-${suffix}`)),
      );
      const [development, nightly, production] = files;
      if (development === undefined || nightly === undefined || production === undefined) {
        throw new Error(`Missing Verne channel asset for ${suffix}`);
      }
      expect(nightly.equals(development), suffix).toBe(true);
      expect(production.equals(development), suffix).toBe(true);
    }
  });
});
