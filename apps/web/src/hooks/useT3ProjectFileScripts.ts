import {
  type EnvironmentId,
  type ProjectFileName,
  type T3ProjectFile,
  type T3ProjectFileScript,
  T3_PROJECT_FILE_NAME,
  VERNE_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import {
  parseT3ProjectFile,
  selectProjectFileCandidate,
  type ProjectFileCandidateState,
} from "@t3tools/shared/t3ProjectFile";
import { useMemo } from "react";

import {
  projectFileReadFailureIsMissing,
  useProjectFileQuery,
} from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  /**
   * - `valid`: the selected project file exists and decoded.
   * - `invalid`: the selected project file exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: neither project-file candidate exists at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The authoritative candidate, or null only when both candidates are missing. */
  fileName: ProjectFileName | null;
  /** The decoded file when status is `valid`, null otherwise. */
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
}

/**
 * Decoded state of the project's selected checked-in project file, including
 * whether the authoritative file exists but is broken.
 */
export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const verneQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    VERNE_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const t3Query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);

  return useMemo(() => {
    const candidate = (
      fileName: ProjectFileName,
      query: typeof verneQuery,
    ): ProjectFileCandidateState => {
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
      // A legacy or mocked query may expose only the display error. Treat it
      // as present-invalid so a read failure cannot silently enable fallback.
      if (query.error !== null) return { status: "invalid", fileName, file: null };
      return { status: "missing", fileName, file: null };
    };

    const selected = selectProjectFileCandidate([
      candidate(VERNE_PROJECT_FILE_NAME, verneQuery),
      candidate(T3_PROJECT_FILE_NAME, t3Query),
    ]);
    return {
      ...selected,
      scripts: selected.status === "valid" ? (selected.file.scripts ?? NO_SCRIPTS) : NO_SCRIPTS,
    };
  }, [
    t3Query.data,
    t3Query.error,
    t3Query.failureCause,
    t3Query.isPending,
    verneQuery.data,
    verneQuery.error,
    verneQuery.failureCause,
    verneQuery.isPending,
  ]);
}

/**
 * Scripts declared in the selected checked-in project file, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to an
 * empty list.
 */
export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}
