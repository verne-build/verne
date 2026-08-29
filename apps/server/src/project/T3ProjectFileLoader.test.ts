import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (
  cwd: string,
  fileName: "verne.json" | "t3.json",
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, fileName), contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("T3ProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("loads and decodes a valid t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          "t3.json",
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when t3.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "t3.json", "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "t3.json", '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("prefers valid verne.json over valid t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "verne.json", '{ "iconPath": "assets/verne.svg" }');
        yield* writeProjectFile(cwd, "t3.json", '{ "iconPath": "assets/t3.svg" }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/verne.svg");
        }
      }),
    );

    it.effect("falls back to valid t3.json when verne.json is absent", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "t3.json", '{ "iconPath": "assets/t3.svg" }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/t3.svg");
        }
      }),
    );

    it.effect("does not fall back to valid t3.json when verne.json is malformed", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "verne.json", "{ not json");
        yield* writeProjectFile(cwd, "t3.json", '{ "iconPath": "assets/t3.svg" }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("does not fall back to valid t3.json when verne.json cannot be read", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const verneFilePath = path.join(cwd, "verne.json");
        yield* writeProjectFile(cwd, "verne.json", '{ "iconPath": "assets/verne.svg" }');
        yield* writeProjectFile(cwd, "t3.json", '{ "iconPath": "assets/t3.svg" }');
        const readPaths: Array<string> = [];
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: verneFilePath,
        });
        const loader = yield* T3ProjectFileLoader.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fileSystem,
              readFileString: (filePath, options) => {
                readPaths.push(String(filePath));
                return String(filePath) === verneFilePath
                  ? Effect.fail(cause)
                  : fileSystem.readFileString(filePath, options);
              },
            }),
          ),
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
        expect(readPaths).toEqual([verneFilePath]);
      }),
    );
  });
});
