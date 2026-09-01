import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";

interface PublishSourcePackageJson {
  readonly name: string;
  readonly repository: {
    readonly type: string;
    readonly url: string;
    readonly directory: string;
  };
  readonly bin: Readonly<Record<string, string>>;
  readonly type: string;
  readonly version: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly publishConfig: {
    readonly executableFiles: ReadonlyArray<string>;
  };
}

interface PublishWorkspaceConfig {
  readonly catalog?: Readonly<Record<string, string>> | undefined;
  readonly overrides?: Readonly<Record<string, string>> | undefined;
}

interface CreatePublishPackageJsonInput {
  readonly serverPackageJson: PublishSourcePackageJson;
  readonly workspaceConfig: PublishWorkspaceConfig;
  readonly version: string;
}

export function createPublishPackageJson({
  serverPackageJson,
  workspaceConfig,
  version,
}: CreatePublishPackageJsonInput) {
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};

  return {
    name: serverPackageJson.name,
    repository: serverPackageJson.repository,
    bin: serverPackageJson.bin,
    type: serverPackageJson.type,
    version,
    engines: serverPackageJson.engines,
    files: serverPackageJson.files,
    dependencies: resolveCatalogDependencies(
      serverPackageJson.dependencies,
      workspaceCatalog,
      "apps/server",
    ),
    overrides: resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/server"),
    publishConfig: serverPackageJson.publishConfig,
  };
}
