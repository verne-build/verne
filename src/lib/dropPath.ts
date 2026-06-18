// Shared state for dragging a file/dir path onto a terminal.
// File tabs (dnd-kit, pointer-based) and the file tree (custom, native HTML5
// drag) use incompatible drag systems, so both publish the dragged absolute
// path here and the terminal reads it on drop.

let draggedPath: string | null = null;

export function setDraggedPath(p: string | null) {
  draggedPath = p;
}

export function getDraggedPath(): string | null {
  return draggedPath;
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
