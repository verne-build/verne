import { sendTextToSession } from "@/composables/useTerminal";

export type InsertionTarget =
  | { kind: "terminal"; sessionId: string | null }
  | { kind: "text"; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: "contentEditable"; element: HTMLElement }
  | { kind: "none" };

// Classify the focused element into an insertion target. The grid terminal's
// hidden input (`.terminal-input`) is the active element while a terminal is
// focused; its PTY session id is carried on the closest ancestor with
// data-session-id (TerminalPane.vue).
export function classifyTarget(el: Element | null): InsertionTarget {
  if (!el) return { kind: "none" };
  if (el instanceof HTMLTextAreaElement && el.classList.contains("terminal-input")) {
    const host = el.closest<HTMLElement>("[data-session-id]");
    return { kind: "terminal", sessionId: host?.dataset.sessionId ?? null };
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return { kind: "text", element: el };
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return { kind: "contentEditable", element: el };
  }
  return { kind: "none" };
}

export function captureTarget(): InsertionTarget {
  return classifyTarget(document.activeElement);
}

export function insertText(text: string, target: InsertionTarget): void {
  if (!text) return;
  if (target.kind === "terminal") {
    if (target.sessionId) sendTextToSession(target.sessionId, text);
    return;
  }
  if (target.kind === "text") {
    const el = target.element;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (target.kind === "contentEditable") {
    target.element.focus();
    if (!document.execCommand("insertText", false, text)) {
      const sel = window.getSelection();
      const range = sel?.getRangeAt(0);
      if (range) {
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
      }
    }
  }
}
