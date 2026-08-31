import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { importLegacyT3State } from "@t3tools/shared/legacyStateMigration";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;

const AppPackageMetadata = Schema.Struct({
  verneCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

export class DesktopUserDataPathResolutionError extends Schema.TaggedErrorClass<DesktopUserDataPathResolutionError>()(
  "DesktopUserDataPathResolutionError",
  {
    legacyPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to inspect legacy desktop user-data path at "${this.legacyPath}".`;
  }
}

export type LegacyDesktopUserDataImportResult =
  | "imported"
  | "destination-initialized"
  | "source-empty";

export const importLegacyDesktopUserData = Effect.fn(
  "desktop.appIdentity.importLegacyDesktopUserData",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly parentPath: string;
  readonly legacyPath: string;
  readonly vernePath: string;
}): Effect.fn.Return<LegacyDesktopUserDataImportResult, PlatformError> {
  const destinationExists = yield* input.fileSystem.exists(input.vernePath);
  if (destinationExists && (yield* input.fileSystem.readDirectory(input.vernePath)).length > 0) {
    return "destination-initialized";
  }

  const sourceExists = yield* input.fileSystem.exists(input.legacyPath);
  if (!sourceExists || (yield* input.fileSystem.readDirectory(input.legacyPath)).length === 0) {
    return "source-empty";
  }

  yield* input.fileSystem.makeDirectory(input.parentPath, { recursive: true });
  const stagingPath = yield* input.fileSystem.makeTempDirectory({
    directory: input.parentPath,
    prefix: ".verne-userdata-importing-",
  });

  return yield* Effect.gen(function* () {
    yield* input.fileSystem.remove(stagingPath, { recursive: true, force: true });
    yield* input.fileSystem.copy(input.legacyPath, stagingPath, {
      overwrite: false,
      preserveTimestamps: true,
    });

    if (
      (yield* input.fileSystem.exists(input.vernePath)) &&
      (yield* input.fileSystem.readDirectory(input.vernePath)).length > 0
    ) {
      return "destination-initialized" as const;
    }

    yield* input.fileSystem.remove(input.vernePath, { recursive: true, force: true });
    yield* input.fileSystem.rename(stagingPath, input.vernePath);
    return "imported" as const;
  }).pipe(
    Effect.ensuring(
      input.fileSystem
        .remove(stagingPath, { recursive: true, force: true })
        .pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );
});

export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  {
    readonly resolveUserDataPath: Effect.Effect<string, DesktopUserDataPathResolutionError>;
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppIdentity") {}

const normalizeCommitHash = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return COMMIT_HASH_PATTERN.test(trimmed)
    ? Option.some(trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase())
    : Option.none();
};

export const resolveUserDataPath = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  if (environment.usesDefaultBaseDir) {
    yield* Effect.promise(() =>
      importLegacyT3State({
        legacyHome: environment.path.join(environment.homeDirectory, ".t3"),
        verneHome: environment.baseDir,
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not import T3 Code state into the Verne home.", { cause }),
      ),
    );
  }
  const legacyPath = environment.path.join(
    environment.appDataDirectory,
    environment.legacyUserDataDirName,
  );
  const vernePath = environment.path.join(
    environment.appDataDirectory,
    environment.userDataDirName,
  );
  yield* importLegacyDesktopUserData({
    fileSystem,
    parentPath: environment.appDataDirectory,
    legacyPath,
    vernePath,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopUserDataPathResolutionError({
          legacyPath,
          cause,
        }),
    ),
  );
  return vernePath;
}).pipe(Effect.withSpan("desktop.appIdentity.resolveUserDataPath"));

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const commitHashCache = yield* Ref.make<Option.Option<Option.Option<string>>>(Option.none());

  const resolveEmbeddedCommitHash = Effect.gen(function* () {
    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (value) =>
        decodeAppPackageMetadata(value).pipe(
          Effect.map((parsed) =>
            Option.fromNullishOr(parsed.verneCommitHash).pipe(Option.flatMap(normalizeCommitHash)),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });
  });

  const resolveAboutCommitHash = Effect.gen(function* () {
    const cached = yield* Ref.get(commitHashCache);
    if (Option.isSome(cached)) {
      return cached.value;
    }

    const override = Option.flatMap(environment.commitHashOverride, normalizeCommitHash);
    if (Option.isSome(override)) {
      yield* Ref.set(commitHashCache, Option.some(override));
      return override;
    }

    if (!environment.isPackaged) {
      const empty = Option.none<string>();
      yield* Ref.set(commitHashCache, Option.some(empty));
      return empty;
    }

    const commitHash = yield* resolveEmbeddedCommitHash;
    yield* Ref.set(commitHashCache, Option.some(commitHash));
    return commitHash;
  });

  const userDataPath = resolveUserDataPath.pipe(
    Effect.provide(
      yield* Effect.context<DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem>(),
    ),
  );

  const configure = Effect.gen(function* () {
    const commitHash = yield* resolveAboutCommitHash;
    yield* electronApp.setName(environment.displayName);
    yield* electronApp.setAboutPanelOptions({
      applicationName: environment.displayName,
      applicationVersion: environment.appVersion,
      version: Option.getOrElse(commitHash, () => "unknown"),
    });

    if (environment.platform === "win32") {
      yield* electronApp.setAppUserModelId(environment.appUserModelId);
    }

    if (environment.platform === "linux") {
      yield* electronApp.setDesktopName(environment.linuxDesktopEntryName);
    }

    // Unpackaged runs only. A packaged bundle already carries its icon in
    // Info.plist, so setting the dock tile again changes nothing except to
    // overwrite a custom icon the user attached to the app themselves.
    if (environment.platform === "darwin" && !environment.isPackaged) {
      const iconPaths = yield* assets.iconPaths;
      yield* Option.match(iconPaths.png, {
        onNone: () => Effect.void,
        onSome: electronApp.setDockIcon,
      });
    }
  }).pipe(Effect.withSpan("desktop.appIdentity.configure"));

  return DesktopAppIdentity.of({
    resolveUserDataPath: userDataPath,
    configure,
  });
});

export const layer = Layer.effect(DesktopAppIdentity, make);
