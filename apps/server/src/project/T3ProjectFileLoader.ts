/**
 * T3ProjectFileLoader - Effect service that loads the checked-in project file
 * from a workspace root.
 *
 * Project filenames are probed in authoritative precedence order. A missing
 * candidate advances to the next filename, while an unreadable or invalid
 * candidate is logged and stops discovery so callers can fall back to their
 * defaults without silently selecting a lower-precedence file.
 *
 * @module T3ProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { PROJECT_FILE_NAMES_BY_PRECEDENCE, type T3ProjectFile } from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

export class T3ProjectFileLoadError extends Schema.TaggedErrorClass<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} project file at ${this.filePath}.`;
  }
}

/** Service tag for checked-in project file loading. */
export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /**
     * Load and decode the authoritative project file at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (read and decode failures are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: T3ProjectFileLoader["Service"]["load"] = Effect.fn("T3ProjectFileLoader.load")(
    function* (workspaceRoot) {
      for (const fileName of PROJECT_FILE_NAMES_BY_PRECEDENCE) {
        const filePath = path.join(workspaceRoot, fileName);
        const readResult = yield* fileSystem.readFileString(filePath).pipe(
          Effect.map((raw) => ({ _tag: "Found", raw }) as const),
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed({ _tag: "Missing" } as const)
                : logT3ProjectFileLoadError(
                    new T3ProjectFileLoadError({
                      operation: "read",
                      workspaceRoot,
                      filePath,
                      cause: error,
                    }),
                  ).pipe(Effect.as({ _tag: "Invalid" } as const)),
          }),
        );
        if (readResult._tag === "Missing") {
          continue;
        }
        if (readResult._tag === "Invalid") {
          return Option.none<T3ProjectFile>();
        }
        return yield* decodeT3ProjectFileJson(readResult.raw).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            SchemaError: (error) =>
              logT3ProjectFileLoadError(
                new T3ProjectFileLoadError({
                  operation: "decode",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<T3ProjectFile>())),
          }),
        );
      }
      return Option.none<T3ProjectFile>();
    },
  );

  return T3ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
