import {
  EnvironmentId,
  ProjectReadFileError,
  T3_PROJECT_FILE_NAME,
  VERNE_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const results = vi.hoisted(() => new Map<string, unknown>());
const optimisticData = vi.hoisted(() => new Map<string, unknown>());
const executeAtomQuery = vi.hoisted(() => vi.fn());

vi.mock("@t3tools/client-runtime/state/runtime", () => ({ executeAtomQuery }));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: (_environmentId: string, _cwd: string, fileName: string) => fileName,
  projectFileReadFailureIsMissing: (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause) as ProjectReadFileError;
    const fileSystemCause = error.cause as { cause?: unknown } | undefined;
    const platformCause = fileSystemCause?.cause;
    return (
      error._tag === "ProjectReadFileError" &&
      error.operation === "realpath-target" &&
      platformCause instanceof Error &&
      platformCause.message.includes("ENOENT")
    );
  },
  resolveProjectFileQueryData: (
    _environmentId: string,
    _cwd: string,
    fileName: string,
    value: unknown,
  ) => optimisticData.get(fileName) ?? value,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

import { readT3ProjectFileDefaultThreadEnvMode } from "./t3ProjectFileDefaults";

const environmentId = EnvironmentId.make("local");

function data(contents: string) {
  return {
    relativePath: "project.json",
    contents,
    byteLength: contents.length,
    truncated: false,
  };
}

function success(contents: string) {
  return { _tag: "Success", value: data(contents) };
}

function truncated(contents: string) {
  return { _tag: "Success", value: { ...data(contents), truncated: true } };
}

function failure(
  fileName: string,
  operation: "realpath-target" | "read",
  causeMessage = operation === "realpath-target" ? "ENOENT" : "EACCES",
) {
  const fileSystemCause =
    operation === "realpath-target"
      ? { _tag: "WorkspaceFileSystemOperationError", cause: new Error(causeMessage) }
      : new Error(causeMessage);
  return {
    _tag: "Failure",
    cause: Cause.fail(
      new ProjectReadFileError({
        cwd: "/repo",
        relativePath: fileName,
        failure: "operation_failed",
        operation,
        operationPath: `/repo/${fileName}`,
        cause: fileSystemCause,
      }),
    ),
  };
}

describe("readT3ProjectFileDefaultThreadEnvMode", () => {
  beforeEach(() => {
    results.clear();
    optimisticData.clear();
    executeAtomQuery.mockReset();
    executeAtomQuery.mockImplementation((_registry, fileName: string) => results.get(fileName));
  });

  it("uses verne.json without reading t3.json when both are valid", async () => {
    results.set(VERNE_PROJECT_FILE_NAME, success('{"defaultThreadEnvMode":"worktree"}'));
    results.set(T3_PROJECT_FILE_NAME, success('{"defaultThreadEnvMode":"local"}'));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBe(
      "worktree",
    );
    expect(executeAtomQuery).toHaveBeenCalledTimes(1);
    expect(executeAtomQuery.mock.calls[0]?.[1]).toBe(VERNE_PROJECT_FILE_NAME);
  });

  it("falls back to t3.json only when verne.json is missing", async () => {
    results.set(VERNE_PROJECT_FILE_NAME, failure(VERNE_PROJECT_FILE_NAME, "realpath-target"));
    results.set(T3_PROJECT_FILE_NAME, success('{"defaultThreadEnvMode":"local"}'));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBe(
      "local",
    );
    expect(executeAtomQuery.mock.calls.map((call) => call[1])).toEqual([
      VERNE_PROJECT_FILE_NAME,
      T3_PROJECT_FILE_NAME,
    ]);
  });

  it("does not fall back after invalid verne.json", async () => {
    results.set(VERNE_PROJECT_FILE_NAME, success("{ invalid"));
    results.set(T3_PROJECT_FILE_NAME, success('{"defaultThreadEnvMode":"local"}'));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBeNull();
    expect(executeAtomQuery).toHaveBeenCalledTimes(1);
  });

  it("does not fall back after truncated verne.json", async () => {
    results.set(VERNE_PROJECT_FILE_NAME, truncated('{"defaultThreadEnvMode":"worktree"}'));
    results.set(T3_PROJECT_FILE_NAME, success('{"defaultThreadEnvMode":"local"}'));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBeNull();
    expect(executeAtomQuery).toHaveBeenCalledTimes(1);
  });

  it("does not fall back after unreadable verne.json", async () => {
    results.set(
      VERNE_PROJECT_FILE_NAME,
      failure(VERNE_PROJECT_FILE_NAME, "realpath-target", "EACCES"),
    );
    results.set(T3_PROJECT_FILE_NAME, success('{"defaultThreadEnvMode":"local"}'));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBeNull();
    expect(executeAtomQuery).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing null default when both files are missing", async () => {
    results.set(VERNE_PROJECT_FILE_NAME, failure(VERNE_PROJECT_FILE_NAME, "realpath-target"));
    results.set(T3_PROJECT_FILE_NAME, failure(T3_PROJECT_FILE_NAME, "realpath-target"));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBeNull();
  });

  it("uses an optimistic verne.json overlay when the backing query failed", async () => {
    results.set(VERNE_PROJECT_FILE_NAME, failure(VERNE_PROJECT_FILE_NAME, "realpath-target"));
    results.set(T3_PROJECT_FILE_NAME, success('{"defaultThreadEnvMode":"local"}'));
    optimisticData.set(VERNE_PROJECT_FILE_NAME, data('{"defaultThreadEnvMode":"worktree"}'));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBe(
      "worktree",
    );
    expect(executeAtomQuery).toHaveBeenCalledTimes(1);
  });
});
