import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  type ProjectFileName,
  T3ProjectFile,
  T3_PROJECT_FILE_SCHEMA_URL,
} from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link T3ProjectFile}.
 */
export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

/**
 * Decode raw `t3.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/** State of a checked-in project-file candidate after its read and decode attempt. */
export type ProjectFileCandidateState =
  | {
      readonly status: "loading";
      readonly fileName: ProjectFileName;
      readonly file: null;
    }
  | {
      readonly status: "missing";
      readonly fileName: ProjectFileName;
      readonly file: null;
    }
  | {
      readonly status: "invalid";
      readonly fileName: ProjectFileName;
      readonly file: null;
    }
  | {
      readonly status: "valid";
      readonly fileName: ProjectFileName;
      readonly file: T3ProjectFile;
    };

/** The resolved project file, including the filename used for source-specific UI copy. */
export type ProjectFileSelection =
  | Exclude<ProjectFileCandidateState, { status: "missing" }>
  | {
      readonly status: "missing";
      readonly fileName: null;
      readonly file: null;
    };

/**
 * Select the first present project-file candidate. Candidates must be ordered
 * by precedence; only a missing file permits considering the next candidate.
 */
export function selectProjectFileCandidate(
  candidates: ReadonlyArray<ProjectFileCandidateState>,
): ProjectFileSelection {
  for (const candidate of candidates) {
    if (candidate.status !== "missing") return candidate;
  }
  return { status: "missing", fileName: null, file: null };
}

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link T3_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildT3ProjectFileJsonSchema(
  schemaUrl = T3_PROJECT_FILE_SCHEMA_URL,
): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: schemaUrl,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
