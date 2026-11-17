// Single source of truth for "can we render this file instead of editing it?".
// Kept dependency-free so both the tab chrome (FileEditorTab) and the preview
// components can import it without pulling Monaco/pdf.js into the main bundle.

export type PreviewKind = "image" | "svg" | "markdown" | "pdf" | "video" | "audio";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "avif"]);
// Chromium codecs: H.264/MP4, WebM, Ogg/Theora. HEVC, MKV and AVI are not
// decodable — they fall through to the "can't play" state in MediaPreview.
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "weba"]);

export function fileExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Markdown source that has an edit ⇄ preview toggle. Mirrors isMarkdownPath. */
export function isMarkdownFile(path: string): boolean {
  const ext = fileExtension(path);
  return ext === "md" || ext === "markdown";
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(fileExtension(path));
}

export function isSvgFile(path: string): boolean {
  return fileExtension(path) === "svg";
}

export function isPdfFile(path: string): boolean {
  return fileExtension(path) === "pdf";
}

export function isVideoFile(path: string): boolean {
  return VIDEO_EXTS.has(fileExtension(path));
}

export function isAudioFile(path: string): boolean {
  return AUDIO_EXTS.has(fileExtension(path));
}

/**
 * The preview the tab should render *instead of* the Monaco editor. `null`
 * means "text — open in the editor". SVG/Markdown stay in the editor by
 * default; they only opt into preview through the Edit/Preview toggle.
 */
export function previewKindForPath(path: string): PreviewKind | null {
  if (isImageFile(path)) return "image";
  if (isPdfFile(path)) return "pdf";
  if (isVideoFile(path)) return "video";
  if (isAudioFile(path)) return "audio";
  return null;
}

/** File is rendered by a preview component, so never read as UTF-8 text. */
export function isBinaryPreviewPath(path: string): boolean {
  return previewKindForPath(path) !== null;
}
