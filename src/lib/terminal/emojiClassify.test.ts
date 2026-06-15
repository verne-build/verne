import { describe, it, expect } from 'vitest';
import { isEmojiCp, isEmojiCell } from './WebGL2Renderer';
import type { Cell } from './gridProtocol';

const cell = (cp: number, zw?: number[]): Cell => ({ cp, fg: 0, bg: 0, flags: 0, width: 1, zw });

describe('emoji classification (tinted text vs untinted color-emoji)', () => {
  // Regression: Claude Code colors its spinner symbols (✶ ✳ ✻ ✽ ✺, U+2700–27BF)
  // and misc symbols (☀ ☁, U+2600–26FF) via SGR. These are TEXT-presentation by
  // default and MUST take the tinted path — routing them to the color-emoji
  // shader rendered them as an untinted white mask (the "colored text is white"
  // bug). They are emoji only when followed by VS16.
  it('treats SGR-colored symbol/dingbat glyphs as text, not emoji', () => {
    for (const cp of [
      // Claude Code spinner stars (and the surrounding U+2722–273D star band).
      0x2722 /* ✢ */, 0x2726 /* ✦ */, 0x2727 /* ✧ */, 0x2733 /* ✳ */,
      0x2734 /* ✴ */, 0x2736 /* ✶ */, 0x2738 /* ✸ */, 0x2739 /* ✹ */,
      0x273a /* ✺ */, 0x273b /* ✻ */, 0x273d /* ✽ */,
      0x2600 /* ☀ */, 0x2601 /* ☁ */, 0x2702 /* ✂ */, 0x2764 /* ❤ */,
    ]) {
      expect(isEmojiCp(cp), `U+${cp.toString(16)} must be text-presented`).toBe(false);
      expect(isEmojiCell(cell(cp))).toBe(false);
    }
  });

  it('still treats true emoji blocks as color emoji', () => {
    expect(isEmojiCp(0x1f600)).toBe(true); // 😀
    expect(isEmojiCp(0x1f1e6)).toBe(true); // 🇦 regional indicator
    expect(isEmojiCell(cell(0x1f680))).toBe(true); // 🚀
  });

  // Emoji_Presentation=Yes members of the BMP symbol span render as COLOR emoji
  // by default (no VS16). They sit inside U+2600–27BF but must take the color
  // path, unlike their text-presented neighbors above.
  it('treats BMP default-presentation emoji as color emoji', () => {
    for (const cp of [
      0x2705 /* ✅ */, 0x274c /* ❌ */, 0x2728 /* ✨ */, 0x2b50 /* ⭐ */,
      0x23f0 /* ⏰ */, 0x267f /* ♿ */, 0x26a1 /* ⚡ */, 0x2b55 /* ⭕ */,
    ]) {
      expect(isEmojiCp(cp), `U+${cp.toString(16)} must be color emoji`).toBe(true);
      expect(isEmojiCell(cell(cp))).toBe(true);
    }
  });

  // Adjacent text-presented symbols (Emoji_Presentation=No) must stay on the
  // tinted path even though they neighbor default-emoji codepoints.
  it('keeps adjacent text-presented symbols on the tinted path', () => {
    for (const cp of [0x2702 /* ✂ */, 0x2709 /* ✉ */, 0x2764 /* ❤ */]) {
      expect(isEmojiCp(cp), `U+${cp.toString(16)} must be text-presented`).toBe(false);
    }
  });

  it('honors VS16 to force emoji presentation of a text symbol', () => {
    expect(isEmojiCell(cell(0x2764, [0xfe0f]))).toBe(true); // ❤️
    expect(isEmojiCell(cell(0x2764))).toBe(false); // ❤ (text)
  });

  it('keeps plain letters/digits on the tinted text path', () => {
    for (const ch of ['S', 'k', 'e', '0', ' ']) {
      expect(isEmojiCell(cell(ch.codePointAt(0)!))).toBe(false);
    }
  });
});
