// Terminal color palette + resolution of packed cell colors to CSS strings.
// Packed color format (see gridProtocol.ts): 0 = default; (1<<24)|i = indexed;
// (2<<24)|(r<<16)|(g<<8)|b = rgb.

import { colorKind } from './gridProtocol';

export interface Palette {
  foreground: string;
  background: string;
  cursor: string;
  /** Selection highlight background. */
  selection: string;
  /** Background behind every search match (dim). */
  searchMatch: string;
  /** Background behind the active/current search match (strong). */
  searchMatchCurrent: string;
  /** The 16 ANSI colors (0-7 normal, 8-15 bright). */
  ansi: string[];
}

/** A reasonable dark default; the app overrides this from the active theme. */
export const defaultPalette: Palette = {
  foreground: '#d8d8d8',
  background: '#1e1e1e',
  cursor: '#d8d8d8',
  selection: 'rgba(120, 150, 255, 0.3)',
  searchMatch: 'rgba(234, 179, 8, 0.32)',
  searchMatchCurrent: 'rgba(234, 179, 8, 0.65)',
  ansi: [
    '#000000', '#cd3131', '#0dbc79', '#e5e510',
    '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543',
    '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5',
  ],
};

const clamp = (n: number) => Math.max(0, Math.min(255, n));

/** Map an xterm 256-color index to a CSS color. 0-15 use the palette's ANSI. */
export function ansi256(i: number, palette: Palette): string {
  if (i < 16) return palette.ansi[i] ?? palette.foreground;
  if (i < 232) {
    // 6×6×6 color cube.
    let n = i - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const v = (x: number) => (x === 0 ? 0 : 55 + 40 * x);
    return `rgb(${v(r)}, ${v(g)}, ${v(b)})`;
  }
  // 24-step grayscale ramp.
  const l = clamp(8 + 10 * (i - 232));
  return `rgb(${l}, ${l}, ${l})`;
}

/** Resolve a packed cell color to a CSS string. `fg` selects the default. */
export function resolveColor(packed: number, palette: Palette, fg: boolean): string {
  switch (colorKind(packed)) {
    case 0:
      return fg ? palette.foreground : palette.background;
    case 1:
      return ansi256(packed & 0xff, palette);
    case 2:
      return `rgb(${(packed >> 16) & 0xff}, ${(packed >> 8) & 0xff}, ${packed & 0xff})`;
    default:
      return fg ? palette.foreground : palette.background;
  }
}

/** Parse `rgb(r, g, b)` or `#rgb`/`#rrggbb` into [r,g,b] (0-255). */
export function parseCssColor(css: string): [number, number, number] {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => parseInt(s, 10));
    return [r || 0, g || 0, b || 0];
  }
  let h = css.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function channelLum(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function linearToSrgb(l: number): number {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** Blend `fg` over `bg` with `t` weight on fg, in linear-light space (gamma
 *  correct). Used for faint text so thin glyphs don't read too light on dark
 *  backgrounds the way naive sRGB alpha compositing does. Returns `rgb(...)`. */
export function blendLinear(fg: string, bg: string, t: number): string {
  const f = parseCssColor(fg);
  const b = parseCssColor(bg);
  const ch = (i: number) =>
    linearToSrgb(srgbToLinear(f[i]) * t + srgbToLinear(b[i]) * (1 - t));
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/** Blend `fg` over `bg` with `t` weight on fg in plain sRGB space (naive alpha).
 *  Matches xterm/VTE faint-text dimming, which composites at sRGB. Returns
 *  `rgb(...)`. */
export function blendSrgb(fg: string, bg: string, t: number): string {
  const f = parseCssColor(fg);
  const b = parseCssColor(bg);
  const ch = (i: number) => Math.round(f[i] * t + b[i] * (1 - t));
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/** WCAG relative luminance (0-1). */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

/** WCAG contrast ratio between two colors (1-21). */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Lift `fg` toward white or black (whichever is further from `bg`) until it
 *  meets `ratio` contrast against `bg`. Returns an `rgb(...)` string. No-op when
 *  `ratio <= 1` or already sufficient. */
export function withMinContrast(fg: string, bg: string, ratio: number): string {
  if (ratio <= 1) return fg;
  const f = parseCssColor(fg);
  const b = parseCssColor(bg);
  if (contrastRatio(f, b) >= ratio) return fg;
  // Push toward the extreme that contrasts more with the background.
  const target: [number, number, number] = relativeLuminance(b) < 0.5 ? [255, 255, 255] : [0, 0, 0];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const t = (lo + hi) / 2;
    const c: [number, number, number] = [
      Math.round(f[0] + (target[0] - f[0]) * t),
      Math.round(f[1] + (target[1] - f[1]) * t),
      Math.round(f[2] + (target[2] - f[2]) * t),
    ];
    if (contrastRatio(c, b) >= ratio) hi = t;
    else lo = t;
  }
  const c: [number, number, number] = [
    Math.round(f[0] + (target[0] - f[0]) * hi),
    Math.round(f[1] + (target[1] - f[1]) * hi),
    Math.round(f[2] + (target[2] - f[2]) * hi),
  ];
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
