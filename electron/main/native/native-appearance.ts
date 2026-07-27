import { nativeTheme } from "electron";

export function syncNativeAppearance(appearance: unknown): void {
  nativeTheme.themeSource = appearance === "light" || appearance === "system"
    ? appearance
    : "dark";
}
