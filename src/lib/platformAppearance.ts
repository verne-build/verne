interface PlatformNavigator {
  platform?: string;
  userAgentData?: { platform?: string };
}

export function isMacPlatform(navigatorLike: PlatformNavigator): boolean {
  return /mac/i.test(navigatorLike.userAgentData?.platform ?? navigatorLike.platform ?? "");
}

export function applyPlatformAppearance(
  documentLike: Pick<Document, "documentElement" | "body">,
  navigatorLike: PlatformNavigator,
): void {
  if (!isMacPlatform(navigatorLike)) return;
  documentLike.documentElement.classList.add("macos-vibrancy");
  documentLike.documentElement.style.setProperty("background", "transparent", "important");
  documentLike.body.style.setProperty("background", "transparent", "important");
}
