import type * as monaco from "monaco-editor";

// Color map from vscode-textmate's theme engine
let activeColorMap: string[] = [];

export function setActiveColorMap(colorMap: string[]) {
  activeColorMap = colorMap;
}

export function getActiveColorMap(): string[] {
  return activeColorMap;
}

/**
 * Build Monaco token rules from vscode-textmate's color map.
 * Each color gets a rule: token "fg{i}" → foreground color.
 * Font styles are encoded as separate tokens: "fg{i}-italic", "fg{i}-bold", etc.
 */
export function buildMonacoRulesFromColorMap(colorMap: string[]): monaco.editor.ITokenThemeRule[] {
  const rules: monaco.editor.ITokenThemeRule[] = [];
  const fontStyles = ["", "italic", "bold", "italic bold", "underline", "italic underline", "bold underline", "italic bold underline",
    "strikethrough", "italic strikethrough", "bold strikethrough", "italic bold strikethrough",
    "underline strikethrough", "italic underline strikethrough", "bold underline strikethrough", "italic bold underline strikethrough"];

  for (let i = 1; i < colorMap.length; i++) {
    const hex = colorMap[i];
    if (!hex) continue;
    const foreground = hex.replace("#", "").slice(0, 6); // strip alpha if present
    rules.push({ token: `fg${i}`, foreground });
    // Font style combinations (fontStyle bits 0-3)
    for (let fs = 1; fs < 16; fs++) {
      rules.push({ token: `fg${i}-fs${fs}`, foreground, fontStyle: fontStyles[fs] });
    }
  }
  // Default foreground with font styles only
  for (let fs = 1; fs < 16; fs++) {
    rules.push({ token: `fg0-fs${fs}`, fontStyle: fontStyles[fs] });
  }
  return rules;
}

/**
 * Resolve vscode-textmate binary metadata to a Monaco token name.
 * Foreground index from bits 15-23, font style from bits 11-14.
 */
export function metadataToTokenName(metadata: number): string {
  const fg = (metadata >>> 15) & 0x1FF;
  const fs = (metadata >>> 11) & 0xF;
  const tokenType = (metadata >>> 8) & 0x3;

  let name: string;
  if (fs === 0) name = fg > 0 ? `fg${fg}` : "source";
  else name = fg > 0 ? `fg${fg}-fs${fs}` : `fg0-fs${fs}`;

  // Suffix token type so Monaco skips bracket colorization in strings/comments
  if (tokenType === 1) name += ".comment";
  else if (tokenType === 2) name += ".string";
  else if (tokenType === 3) name += ".regexp";

  return name;
}

/**
 * Resolve foreground color from vscode-textmate binary metadata using the active color map.
 */
export function resolveColorFromMetadata(metadata: number): string | undefined {
  const fg = (metadata >>> 15) & 0x1FF;
  return fg > 0 ? activeColorMap[fg] : undefined;
}

/**
 * Resolve font style string from vscode-textmate binary metadata.
 */
export function resolveFontStyleFromMetadata(metadata: number): number {
  return (metadata >>> 11) & 0xF;
}
