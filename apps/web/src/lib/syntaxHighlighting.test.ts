import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter, registerCustomTheme } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
  registerCustomTheme: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
  registerCustomTheme,
}));

import { getAppliedThemeDefinition, VERNE_THEME } from "../themePalette";
import * as syntaxHighlighting from "./syntaxHighlighting";

const { getSyntaxHighlighterPromise, resolveSyntaxHighlightTheme } = syntaxHighlighting;

it("caches the recovered text highlighter for unsupported languages", async () => {
  const textHighlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text"
      ? Promise.resolve(textHighlighter)
      : Promise.reject(new Error("unsupported language")),
  );

  const first = getSyntaxHighlighterPromise("unsupported-test-language");
  await expect(first).resolves.toBe(textHighlighter);
  const second = getSyntaxHighlighterPromise("unsupported-test-language");

  expect(second).toBe(first);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
});

it("registers the active palette's TextMate rules with Shiki", async () => {
  const highlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockResolvedValueOnce(highlighter);
  const syntaxTheme = resolveSyntaxHighlightTheme(VERNE_THEME, "dark");

  await expect(getSyntaxHighlighterPromise("typescript", syntaxTheme)).resolves.toBe(highlighter);
  expect(registerCustomTheme).toHaveBeenCalledWith(syntaxTheme!.name, expect.any(Function));
  expect(getSharedHighlighter).toHaveBeenLastCalledWith(
    expect.objectContaining({ themes: [syntaxTheme!.name] }),
  );
});

it("uses Verne syntax for the standard System preference", () => {
  const syntaxTheme = resolveSyntaxHighlightTheme(getAppliedThemeDefinition("system"), "dark");

  expect(syntaxTheme?.rules).toBe(VERNE_THEME.syntax);
});

it("registers Verne before returning its theme name to Pierre surfaces", () => {
  const syntaxTheme = resolveSyntaxHighlightTheme(VERNE_THEME, "dark");
  const resolveCodeThemeName = Reflect.get(syntaxHighlighting, "resolveCodeThemeName");

  expect(resolveCodeThemeName).toBeTypeOf("function");
  if (typeof resolveCodeThemeName !== "function") return;

  const themeName = resolveCodeThemeName(syntaxTheme, "dark");

  expect(themeName).toMatch(/^t3-verne-dark-/);
  expect(themeName).not.toBe("pierre-dark");
  expect(registerCustomTheme).toHaveBeenLastCalledWith(themeName, expect.any(Function));
});
