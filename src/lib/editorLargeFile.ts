import type * as monaco from "monaco-editor";

export const LARGE_FILE_SIZE_BYTES = 1024 * 1024;
export const MAX_SAFE_TOKENIZATION_LINE_LENGTH = 20_000;

export interface EditorContentProfile {
  length: number;
  lineCount: number;
  maxLineLength: number;
  isLarge: boolean;
  hasLongLine: boolean;
  shouldDisableLanguageFeatures: boolean;
  shouldOpenAsPlaintext: boolean;
}

export function analyzeEditorContent(content: string): EditorContentProfile {
  let lineCount = 1;
  let currentLineLength = 0;
  let maxLineLength = 0;

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 10) {
      if (currentLineLength > maxLineLength) maxLineLength = currentLineLength;
      currentLineLength = 0;
      lineCount++;
    } else if (code !== 13) {
      currentLineLength++;
    }
  }
  if (currentLineLength > maxLineLength) maxLineLength = currentLineLength;

  const isLarge = content.length >= LARGE_FILE_SIZE_BYTES;
  const hasLongLine = maxLineLength >= MAX_SAFE_TOKENIZATION_LINE_LENGTH;
  const shouldDisableLanguageFeatures = isLarge || hasLongLine;

  return {
    length: content.length,
    lineCount,
    maxLineLength,
    isLarge,
    hasLongLine,
    shouldDisableLanguageFeatures,
    shouldOpenAsPlaintext: shouldDisableLanguageFeatures,
  };
}

export function shouldDisableLanguageFeaturesForModel(
  model: monaco.editor.ITextModel,
): boolean {
  if (model.getValueLength() >= LARGE_FILE_SIZE_BYTES) return true;
  const lineCount = model.getLineCount();
  for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
    if (model.getLineLength(lineNumber) >= MAX_SAFE_TOKENIZATION_LINE_LENGTH) return true;
  }
  return false;
}

export function formatApproxFileSize(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(length / 1024))} KB`;
}
