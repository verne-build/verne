export function resolveComposerCommandMenuPosition(input: {
  rect: { left: number; top: number; width: number };
  viewportHeight: number;
  rootFontSizePx: number;
}) {
  const composerOverlap = input.rootFontSizePx + 1;
  return {
    bottom: input.viewportHeight - input.rect.top - composerOverlap,
    left: input.rect.left,
    maxHeight: Math.max(96, input.rect.top - 24 + composerOverlap),
    width: Math.max(0, input.rect.width),
  };
}
