export const PRODUCT_BASE_NAME = "Verne" as const;

export const VERNE_CLI_PACKAGE = "@verne-build/cli" as const;
export const VERNE_CLI_COMMAND = "verne" as const;
export const VERNE_HOME_DIRECTORY_NAME = ".verne" as const;
export const VERNE_PROJECT_FILE_SCHEMA_URL = "https://verne.build/schema/verne.json" as const;
export const VERNE_WEB_APP_URL = "https://app.verne.build" as const;
export const VERNE_GITHUB_REPOSITORY = "verne-build/verne" as const;

export const VERNE_APP_IDS = {
  production: "build.verne.app",
  development: "build.verne.app.dev",
  preview: "build.verne.app.preview",
} as const;

export const VERNE_SCHEMES = {
  production: "verne",
  development: "verne-dev",
  preview: "verne-preview",
} as const;

export function formatProductDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string | null;
}): string {
  return input.stageLabel === null || input.stageLabel === "Latest"
    ? input.baseName
    : `${input.baseName} (${input.stageLabel})`;
}
