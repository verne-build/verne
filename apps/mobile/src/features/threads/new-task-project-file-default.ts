import {
  PROJECT_FILE_NAMES_BY_PRECEDENCE,
  type ProjectFileName,
  type ProjectReadFileResult,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import {
  parseT3ProjectFile,
  selectProjectFileCandidate,
  type ProjectFileCandidateState,
} from "@t3tools/shared/t3ProjectFile";
import * as Cause from "effect/Cause";

export interface MobileProjectFileQueryState {
  readonly data: ProjectReadFileResult | null;
  readonly error: string | null;
  readonly failureCause: Cause.Cause<unknown> | null;
  readonly isPending: boolean;
}

function projectFileReadFailureIsMissing(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "ProjectReadFileError" ||
    !("operation" in error) ||
    error.operation !== "realpath-target" ||
    !("cause" in error)
  ) {
    return false;
  }

  const visited = new Set<object>();
  const containsNotFoundCause = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || visited.has(value)) return false;
    visited.add(value);
    if ("code" in value && value.code === "ENOENT") return true;
    if (
      "message" in value &&
      typeof value.message === "string" &&
      value.message.includes("ENOENT")
    ) {
      return true;
    }
    return "cause" in value && containsNotFoundCause(value.cause);
  };

  return containsNotFoundCause(error.cause);
}

function candidateFromQuery(
  fileName: ProjectFileName,
  query: MobileProjectFileQueryState,
): ProjectFileCandidateState {
  if (query.data !== null) {
    if (query.data.truncated) return { status: "invalid", fileName, file: null };
    const file = parseT3ProjectFile(query.data.contents);
    return file === null
      ? { status: "invalid", fileName, file: null }
      : { status: "valid", fileName, file };
  }
  if (query.isPending) return { status: "loading", fileName, file: null };
  if (query.failureCause !== null) {
    return projectFileReadFailureIsMissing(query.failureCause)
      ? { status: "missing", fileName, file: null }
      : { status: "invalid", fileName, file: null };
  }
  if (query.error !== null) return { status: "invalid", fileName, file: null };
  return { status: "missing", fileName, file: null };
}

export function resolveMobileProjectFileDefault(
  queries: Readonly<Record<ProjectFileName, MobileProjectFileQueryState>>,
): {
  readonly projectFile: ThreadEnvMode | null;
  readonly projectFilePending: boolean;
} {
  const selected = selectProjectFileCandidate(
    PROJECT_FILE_NAMES_BY_PRECEDENCE.map((fileName) =>
      candidateFromQuery(fileName, queries[fileName]),
    ),
  );
  return {
    projectFile: selected.status === "valid" ? (selected.file.defaultThreadEnvMode ?? null) : null,
    projectFilePending:
      selected.status === "loading" ||
      (selected.fileName !== null && queries[selected.fileName].isPending),
  };
}
