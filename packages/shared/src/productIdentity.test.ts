import { describe, expect, it } from "vite-plus/test";

import { VERNE_PROJECT_FILE_SCHEMA_URL as CONTRACT_SCHEMA_URL } from "@t3tools/contracts";

import {
  formatProductDisplayName,
  PRODUCT_BASE_NAME,
  VERNE_APP_IDS,
  VERNE_CLI_COMMAND,
  VERNE_CLI_PACKAGE,
  VERNE_GITHUB_REPOSITORY,
  VERNE_HOME_DIRECTORY_NAME,
  VERNE_PROJECT_FILE_SCHEMA_URL,
  VERNE_SCHEMES,
  VERNE_WEB_APP_URL,
} from "./productIdentity.ts";

describe("Verne product identity", () => {
  it("provides the public identity consumed by product surfaces", () => {
    expect({
      name: PRODUCT_BASE_NAME,
      cliPackage: VERNE_CLI_PACKAGE,
      cliCommand: VERNE_CLI_COMMAND,
      home: VERNE_HOME_DIRECTORY_NAME,
      schema: VERNE_PROJECT_FILE_SCHEMA_URL,
      webApp: VERNE_WEB_APP_URL,
      repository: VERNE_GITHUB_REPOSITORY,
      appIds: VERNE_APP_IDS,
      schemes: VERNE_SCHEMES,
    }).toEqual({
      name: "Verne",
      cliPackage: "@verne-build/cli",
      cliCommand: "verne",
      home: ".verne",
      schema: "https://verne.build/schema/verne.json",
      webApp: "https://app.verne.build",
      repository: "verne-build/verne",
      appIds: {
        production: "build.verne.app",
        development: "build.verne.app.dev",
        preview: "build.verne.app.preview",
      },
      schemes: {
        production: "verne",
        development: "verne-dev",
        preview: "verne-preview",
      },
    });
  });

  it("keeps the project contract schema aligned with generated Verne files", () => {
    expect(CONTRACT_SCHEMA_URL).toBe(VERNE_PROJECT_FILE_SCHEMA_URL);
  });

  it("omits the stable channel label and shows non-stable channels", () => {
    expect(formatProductDisplayName({ baseName: "Verne", stageLabel: null })).toBe("Verne");
    expect(formatProductDisplayName({ baseName: "Verne", stageLabel: "Latest" })).toBe("Verne");
    expect(formatProductDisplayName({ baseName: "Verne", stageLabel: "Nightly" })).toBe(
      "Verne (Nightly)",
    );
  });
});
