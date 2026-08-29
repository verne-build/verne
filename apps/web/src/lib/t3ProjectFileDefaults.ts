import {
  PROJECT_FILE_NAMES_BY_PRECEDENCE,
  type EnvironmentId,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  projectFileReadFailureIsMissing,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read `defaultThreadEnvMode` from the selected checked-in project file.
 *
 * Imperative counterpart to `useT3ProjectFileScripts` for the new-thread
 * path, which resolves defaults at call time rather than render time. The
 * file query atom caches per (environment, cwd), so repeat calls don't
 * re-fetch. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readT3ProjectFileDefaultThreadEnvMode(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ThreadEnvMode | null> {
  for (const fileName of PROJECT_FILE_NAMES_BY_PRECEDENCE) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, fileName),
      { reportDefect: false, reportFailure: false },
    );
    const data = resolveProjectFileQueryData(
      environmentId,
      workspaceRoot,
      fileName,
      result._tag === "Success" ? result.value : null,
    );
    if (data !== null) {
      if (data.truncated) return null;
      return parseT3ProjectFile(data.contents)?.defaultThreadEnvMode ?? null;
    }
    if (result._tag === "Failure") {
      if (projectFileReadFailureIsMissing(result.cause)) continue;
      return null;
    }
    return null;
  }
  return null;
}
