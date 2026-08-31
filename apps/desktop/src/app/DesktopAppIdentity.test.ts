import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/Verne.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/Verne.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

interface ElectronAppCalls {
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>;
  readonly setDockIcon: string[];
  readonly setName: string[];
}

const makeElectronAppLayer = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("Verne"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: (name) =>
      Effect.sync(() => {
        calls.setName.push(name);
      }),
    setAboutPanelOptions: (options) =>
      Effect.sync(() => {
        calls.setAboutPanelOptions.push(options);
      }),
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() => {
        calls.setDockIcon.push(iconPath);
      }),
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const makeAssetsLayer = (png: Option.Option<string>) =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png,
    }),
    resolveResourcePath: () => Effect.succeed(Option.none()),
  } satisfies DesktopAssets.DesktopAssets["Service"]);

const makeEnvironmentLayer = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  );
};

const withIdentity = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppIdentity.DesktopAppIdentity
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  input: {
    readonly calls?: ElectronAppCalls;
    readonly environment?: TestEnvironmentInput;
    readonly legacyPathExists?: boolean;
    readonly legacyPathProbeError?: PlatformError.PlatformError;
    readonly packageJson?: string;
    readonly pngIconPath?: Option.Option<string>;
  } = {},
) => {
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setDockIcon: [],
    setName: [],
  };

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (path) =>
              input.legacyPathProbeError
                ? Effect.fail(input.legacyPathProbeError)
                : Effect.succeed(
                    input.legacyPathExists === true && path.includes("T3 Code (Alpha)"),
                  ),
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"verneCommitHash":"abcdef1234567890"}'),
          }),
        ),
        Layer.provideMerge(makeAssetsLayer(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(makeElectronAppLayer(calls)),
        Layer.provideMerge(makeEnvironmentLayer(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  it.effect("imports the default T3 home before resolving desktop userData", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "verne-desktop-home-" });
        const legacyState = `${root}/.t3/userdata`;
        yield* fileSystem.makeDirectory(legacyState, { recursive: true });
        yield* fileSystem.writeFileString(`${legacyState}/settings.json`, '{"theme":"dark"}');

        const calls: ElectronAppCalls = {
          setAboutPanelOptions: [],
          setDockIcon: [],
          setName: [],
        };
        const identityLayer = DesktopAppIdentity.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(makeAssetsLayer(Option.none())),
          Layer.provideMerge(makeElectronAppLayer(calls)),
          Layer.provideMerge(
            makeEnvironmentLayer({
              homeDirectory: root,
              platform: "linux",
              appPath: `${root}/app.asar`,
              resourcesPath: root,
            }),
          ),
        );

        const userDataPath = yield* DesktopAppIdentity.DesktopAppIdentity.pipe(
          Effect.flatMap((identity) => identity.resolveUserDataPath),
          Effect.provide(identityLayer),
        );

        assert.equal(userDataPath, `${root}/.config/verne`);
        assert.equal(
          yield* fileSystem.readFileString(`${root}/.verne/userdata/settings.json`),
          '{"theme":"dark"}',
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("imports legacy userData into an empty Verne directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "verne-userdata-import-" });
      const legacyPath = `${root}/T3 Code (Alpha)`;
      const vernePath = `${root}/verne`;
      yield* fileSystem.makeDirectory(legacyPath, { recursive: true });
      yield* fileSystem.writeFileString(`${legacyPath}/Preferences`, "legacy-preferences");

      const result = yield* DesktopAppIdentity.importLegacyDesktopUserData({
        fileSystem,
        parentPath: root,
        legacyPath,
        vernePath,
      });

      assert.equal(result, "imported");
      assert.equal(
        yield* fileSystem.readFileString(`${vernePath}/Preferences`),
        "legacy-preferences",
      );
      assert.equal(
        yield* fileSystem.readFileString(`${legacyPath}/Preferences`),
        "legacy-preferences",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not merge legacy userData into initialized Verne state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "verne-userdata-import-" });
      const legacyPath = `${root}/T3 Code (Alpha)`;
      const vernePath = `${root}/verne`;
      yield* fileSystem.makeDirectory(legacyPath, { recursive: true });
      yield* fileSystem.makeDirectory(vernePath, { recursive: true });
      yield* fileSystem.writeFileString(`${legacyPath}/Preferences`, "legacy-preferences");
      yield* fileSystem.writeFileString(`${vernePath}/Preferences`, "verne-preferences");

      const result = yield* DesktopAppIdentity.importLegacyDesktopUserData({
        fileSystem,
        parentPath: root,
        legacyPath,
        vernePath,
      });

      assert.equal(result, "destination-initialized");
      assert.equal(
        yield* fileSystem.readFileString(`${vernePath}/Preferences`),
        "verne-preferences",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves failures while inspecting the legacy userData path", () => {
    const legacyPath = "/Users/alice/Library/Application Support/T3 Code (Alpha)";
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      description: "permission denied",
      pathOrDescriptor: legacyPath,
    });

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const error = yield* identity.resolveUserDataPath.pipe(Effect.flip);

        assert.instanceOf(error, DesktopAppIdentity.DesktopUserDataPathResolutionError);
        assert.equal(error.legacyPath, legacyPath);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          `Failed to inspect legacy desktop user-data path at "${legacyPath}".`,
        );
      }),
      { legacyPathProbeError: cause },
    );
  });

  it.effect("configures app identity from the environment commit override", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        assert.deepEqual(calls.setName, ["Verne (Alpha)"]);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "Verne (Alpha)");
        assert.equal(calls.setAboutPanelOptions[0]?.applicationVersion, "1.2.3");
        assert.equal(calls.setAboutPanelOptions[0]?.version, "0123456789ab");
        // Packaged: the bundle's own icon stands, so a custom one the user
        // attached survives.
        assert.deepEqual(calls.setDockIcon, []);
      }),
      {
        calls,
        environment: {
          env: {
            VERNE_COMMIT_HASH: "0123456789abcdef",
          },
        },
        pngIconPath: Option.some("/icon.png"),
      },
    );
  });

  it.effect("sets the dock icon only when running unpackaged", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        // Electron shows a generic icon for an unpackaged run, which is the
        // reason this call exists at all.
        assert.deepEqual(calls.setDockIcon, ["/icon.png"]);
      }),
      {
        calls,
        environment: { isPackaged: false },
        pngIconPath: Option.some("/icon.png"),
      },
    );
  });
});
