import { nativeImage } from "electron";
import { extname } from "node:path";
import { registerNative } from "../ipc-router";

const ALPHA_THRESHOLD = 255 * 0.95;
const TRANSPARENT_PIXEL_RATIO = 0.05;
const SAMPLE_SIZE = 32;

export function bitmapHasMeaningfulTransparency(bitmap: Uint8Array): boolean {
  const pixelCount = Math.floor(bitmap.length / 4);
  if (!pixelCount) return false;

  let transparentCount = 0;
  const requiredCount = Math.ceil(pixelCount * TRANSPARENT_PIXEL_RATIO);
  for (let alphaIndex = 3; alphaIndex < pixelCount * 4; alphaIndex += 4) {
    if (bitmap[alphaIndex]! < ALPHA_THRESHOLD && ++transparentCount >= requiredCount)
      return true;
  }
  return false;
}

export function projectIconHasTransparentBackground(path: string): boolean {
  if (!path) return false;
  if (extname(path).toLowerCase() === ".svg") return true;
  try {
    const image = nativeImage.createFromPath(path);
    if (image.isEmpty()) return false;
    const size = image.getSize();
    const scale = Math.min(1, SAMPLE_SIZE / Math.max(size.width, size.height));
    const sampled = scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "good",
        })
      : image;
    return bitmapHasMeaningfulTransparency(sampled.toBitmap({ scaleFactor: 1 }));
  } catch {
    return false;
  }
}

export function registerProjectIconCommands(): void {
  registerNative("project_icon_has_transparent_background", (p: { path?: string }) =>
    projectIconHasTransparentBackground(p.path ?? ""));
}
