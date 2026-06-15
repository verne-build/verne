// Inject the macOS 26 Liquid Glass icon catalog (Assets.car) into the app
// bundle. electron-builder has no native .icon support yet (electron-userland/
// electron-builder#9254), so we copy the actool-compiled catalog ourselves.
// Build it with: actool AppIcon.icon --compile build/compiled --app-icon AppIcon ...
import { copyFile, access } from "node:fs/promises";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const src = join(context.packager.projectDir, "build/compiled/Assets.car");
  try {
    await access(src);
  } catch {
    console.warn(`[after-pack] ${src} missing — skipping Liquid Glass icon`);
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const dest = join(context.appOutDir, appName, "Contents/Resources/Assets.car");
  await copyFile(src, dest);
  console.log(`[after-pack] copied Assets.car → ${dest}`);
}
