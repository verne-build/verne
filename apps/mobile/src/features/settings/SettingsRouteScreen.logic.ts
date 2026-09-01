export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}

export function formatMobileVersionLabel(input: {
  readonly version: string;
  readonly buildVersion: string | null | undefined;
  readonly variant: string;
}): string {
  const buildVersion = input.buildVersion?.trim();
  const buildLabel = buildVersion ? ` (${buildVersion})` : "";
  const variantLabel =
    input.variant === "production"
      ? ""
      : ` · ${input.variant.charAt(0).toUpperCase()}${input.variant.slice(1)}`;
  return `${input.version}${buildLabel}${variantLabel}`;
}
