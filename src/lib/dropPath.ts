// Shared state for dragging a file/dir path onto a terminal.
// File tabs (dnd-kit, pointer-based) and the file tree (custom, native HTML5
// drag) use incompatible drag systems, so both publish the dragged absolute
// path here and the terminal reads it on drop.

import { filePathForFile } from "@/platform";

let draggedPath: string | null = null;
export const VERNE_PATHS_MIME = "application/x-verne-paths";

export function setDraggedPath(p: string | null) {
  draggedPath = p;
}

export function getDraggedPath(): string | null {
  return draggedPath;
}

export function hasNativeFileDrop(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function hasPathDrop(e: DragEvent): boolean {
  return !!getDraggedPath() || hasNativeFileDrop(e);
}

function nativeFilePath(file: File): string {
  try {
    return filePathForFile(file);
  } catch {
    return (file as unknown as { path?: string }).path ?? "";
  }
}

function cleanPaths(paths: string[]): string[] {
  return paths.filter(Boolean);
}

export function getDroppedPaths(e: DragEvent): string[] {
  const raw = e.dataTransfer?.getData(VERNE_PATHS_MIME);
  if (raw) {
    try {
      const paths = JSON.parse(raw);
      if (Array.isArray(paths)) return cleanPaths(paths.filter((p): p is string => typeof p === "string"));
    } catch {}
  }

  const files = Array.from(e.dataTransfer?.files ?? []);
  const filePaths = cleanPaths(files.map(nativeFilePath));
  if (filePaths.length) return filePaths;

  const dragged = getDraggedPath();
  return dragged ? [dragged] : [];
}

// Custom events a non-native (dnd-kit) drag dispatches on the terminal element
// under the cursor — native drag fires real dragover/drop/dragleave, but
// dnd-kit fires none of them, so the tab drag drives drop + highlight manually.
export const PASTE_PATH_EVENT = "verne:paste-path";
export const PASTE_PATH_ENTER_EVENT = "verne:paste-path-enter";
export const PASTE_PATH_LEAVE_EVENT = "verne:paste-path-leave";

// Format an absolute path for shell insertion: quote if it contains anything
// outside a safe unquoted set, then a trailing space (matches macOS Terminal's
// drag-to-paste behaviour so the next token is separated).
export function formatPathForShell(path: string): string {
  if (/[^A-Za-z0-9_./~@%+=:-]/.test(path)) {
    return `'${path.replace(/'/g, "'\\''")}' `;
  }
  return `${path} `;
}

export function formatPathsForShell(paths: string[]): string {
  return paths.map(formatPathForShell).join("");
}
