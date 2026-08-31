import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFileJsonSchema,
  parseT3ProjectFile,
  selectProjectFileCandidate,
  type ProjectFileSelection,
  T3ProjectFileFromJson,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

function assertMissingSelectionHasNoCandidateFileName(selection: ProjectFileSelection) {
  if (selection.status === "missing") {
    const fileName: null = selection.fileName;
    void fileName;
  }
}

void assertMissingSelectionHasNoCandidateFileName;

describe("buildT3ProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the published $id", () => {
    const schema = buildT3ProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://t3.codes/schema/t3.json");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("emits the Verne schema at its public route", () => {
    const schema = buildT3ProjectFileJsonSchema("https://verne.build/schema/verne.json");

    expect(schema.$id).toBe("https://verne.build/schema/verne.json");
  });

  it("documents every supported field", () => {
    const schema = buildT3ProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        }
      >;
      required?: ReadonlyArray<string>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      "$schema",
      "defaultThreadEnvMode",
      "iconPath",
      "scripts",
    ]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");
    expect(schema.properties.defaultThreadEnvMode?.description).toContain("new threads start");

    const script = schema.properties.scripts?.items;
    expect(script?.required).toEqual(["name", "command"]);
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual([
      "autoOpenPreview",
      "command",
      "icon",
      "name",
      "previewUrl",
      "runOnWorktreeCreate",
    ]);
  });

  it("stays JSON-serializable", () => {
    const schema = buildT3ProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseT3ProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseT3ProjectFile('{ "defaultThreadEnvMode": "worktree" }')).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseT3ProjectFile("{ not json")).toBeNull();
    expect(parseT3ProjectFile('{ "defaultThreadEnvMode": "spaceship" }')).toBeNull();
  });
});

describe("selectProjectFileCandidate", () => {
  const validVerne = {
    status: "valid" as const,
    fileName: "verne.json" as const,
    file: { iconPath: "assets/verne.svg" },
  };
  const validT3 = {
    status: "valid" as const,
    fileName: "t3.json" as const,
    file: { iconPath: "assets/t3.svg" },
  };

  it("selects Verne when both project files are valid", () => {
    expect(selectProjectFileCandidate([validVerne, validT3])).toEqual(validVerne);
  });

  it("falls back to T3 when Verne is missing", () => {
    expect(
      selectProjectFileCandidate([
        { status: "missing", fileName: "verne.json", file: null },
        validT3,
      ]),
    ).toEqual(validT3);
  });

  it("keeps an invalid Verne file authoritative over valid T3", () => {
    expect(
      selectProjectFileCandidate([
        { status: "invalid", fileName: "verne.json", file: null },
        validT3,
      ]),
    ).toEqual({ status: "invalid", fileName: "verne.json", file: null });
  });

  it("keeps a loading Verne file authoritative over valid T3", () => {
    expect(
      selectProjectFileCandidate([
        { status: "loading", fileName: "verne.json", file: null },
        validT3,
      ]),
    ).toEqual({ status: "loading", fileName: "verne.json", file: null });
  });

  it("returns missing when neither project file exists", () => {
    expect(
      selectProjectFileCandidate([
        { status: "missing", fileName: "verne.json", file: null },
        { status: "missing", fileName: "t3.json", file: null },
      ]),
    ).toEqual({ status: "missing", fileName: null, file: null });
  });
});
