import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_FILE_NAMES_BY_PRECEDENCE,
  type ProjectFileName,
  T3ProjectFile,
  VERNE_PROJECT_FILE_SCHEMA_URL,
  VERNE_PROJECT_FILE_NAME,
} from "./t3ProjectFile.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;
type ProjectFileNameIncludesOnlyConfiguredNames = Assert<
  Equal<ProjectFileName, "verne.json" | "t3.json">
>;

void (0 as unknown as ProjectFileNameIncludesOnlyConfiguredNames);

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile", () => {
  it("defines Verne-first project-file precedence", () => {
    expect(VERNE_PROJECT_FILE_NAME).toBe("verne.json");
    expect(PROJECT_FILE_NAMES_BY_PRECEDENCE).toEqual(["verne.json", "t3.json"]);
    expect(VERNE_PROJECT_FILE_SCHEMA_URL).toBe("https://verne.build/schema/verne.json");
  });

  it("decodes a full project file", () => {
    const decoded = decode({
      $schema: "https://t3.codes/schema/t3.json",
      iconPath: "assets/logo.svg",
      scripts: [
        {
          name: "Dev",
          command: "pnpm dev",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://localhost:3000",
          autoOpenPreview: true,
        },
        { name: "Test", command: "pnpm test" },
      ],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts).toHaveLength(2);
    expect(decoded.scripts?.[1]).toEqual({ name: "Test", command: "pnpm test" });
  });

  it("decodes an empty object and ignores unknown fields", () => {
    expect(decode({})).toEqual({});
    expect(decode({ futureField: true })).toEqual({});
  });

  it("trims icon paths and script fields", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
      scripts: [{ name: " Dev ", command: " pnpm dev " }],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("rejects scripts without a command", () => {
    expect(() => decode({ scripts: [{ name: "Dev" }] })).toThrow();
  });

  it("rejects unknown script icons", () => {
    expect(() =>
      decode({ scripts: [{ name: "Dev", command: "pnpm dev", icon: "rocket" }] }),
    ).toThrow();
  });

  it("decodes defaultThreadEnvMode and rejects unknown modes", () => {
    expect(decode({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe("worktree");
    expect(decode({ defaultThreadEnvMode: "local" }).defaultThreadEnvMode).toBe("local");
    expect(() => decode({ defaultThreadEnvMode: "remote" })).toThrow();
  });
});
