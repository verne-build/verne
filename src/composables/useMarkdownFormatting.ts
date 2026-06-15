import * as monaco from "monaco-editor";
import { applyAction, type FormatAction } from "@/lib/markdownFormat";

/** True for files the toolbar should appear on. */
export function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown";
}

/** Apply a formatting action to the editor's current selection. */
export function runMarkdownAction(
  editor: monaco.editor.IStandaloneCodeEditor,
  action: FormatAction,
): void {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;

  const from = model.getOffsetAt(sel.getStartPosition());
  const to = model.getOffsetAt(sel.getEndPosition());
  const edit = applyAction(action, model.getValue(), from, to);

  const range = monaco.Range.fromPositions(
    model.getPositionAt(edit.from),
    model.getPositionAt(edit.to),
  );

  editor.pushUndoStop();
  editor.executeEdits("md-format", [{ range, text: edit.insert, forceMoveMarkers: true }]);
  editor.pushUndoStop();

  editor.setSelection(
    monaco.Range.fromPositions(
      model.getPositionAt(edit.selFrom),
      model.getPositionAt(edit.selTo),
    ),
  );
  editor.focus();
}
