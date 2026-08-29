import {
  ProjectReadFileError,
  T3_PROJECT_FILE_NAME,
  VERNE_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveMobileProjectFileDefault,
  type MobileProjectFileQueryState,
} from "./new-task-project-file-default";

function data(contents: string, truncated = false) {
  return {
    relativePath: "project.json",
    contents,
    byteLength: contents.length,
    truncated,
  };
}

function query(overrides: Partial<MobileProjectFileQueryState> = {}): MobileProjectFileQueryState {
  return {
    data: null,
    error: null,
    failureCause: null,
    isPending: false,
    ...overrides,
  };
}

function readFailure(
  fileName: typeof VERNE_PROJECT_FILE_NAME | typeof T3_PROJECT_FILE_NAME,
  input: { readonly operation: "realpath-target" | "open"; readonly code: string },
) {
  const platformCause = Object.assign(new Error(`${input.code}: ${fileName}`), {
    code: input.code,
  });
  const workspaceFileSystemCause = {
    _tag: "WorkspaceFileSystemOperationError",
    workspaceRoot: "/repo",
    relativePath: fileName,
    resolvedPath: `/repo/${fileName}`,
    operationPath: `/repo/${fileName}`,
    operation: input.operation,
    cause: platformCause,
  };
  return Cause.fail(
    new ProjectReadFileError({
      cwd: "/repo",
      relativePath: fileName,
      failure: "operation_failed",
      operation: input.operation,
      operationPath: `/repo/${fileName}`,
      cause: workspaceFileSystemCause,
    }),
  );
}

describe("resolveMobileProjectFileDefault", () => {
  it("uses a valid verne.json when both project files are valid", () => {
    expect(
      resolveMobileProjectFileDefault({
        [VERNE_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"worktree"}') }),
        [T3_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"local"}') }),
      }),
    ).toEqual({ projectFile: "worktree", projectFilePending: false });
  });

  it("falls back to valid t3.json only when verne.json is genuinely missing", () => {
    expect(
      resolveMobileProjectFileDefault({
        [VERNE_PROJECT_FILE_NAME]: query({
          error: "Failed to read workspace file.",
          failureCause: readFailure(VERNE_PROJECT_FILE_NAME, {
            operation: "realpath-target",
            code: "ENOENT",
          }),
        }),
        [T3_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"local"}') }),
      }),
    ).toEqual({ projectFile: "local", projectFilePending: false });
  });

  it("keeps malformed verne.json authoritative and settled", () => {
    expect(
      resolveMobileProjectFileDefault({
        [VERNE_PROJECT_FILE_NAME]: query({ data: data("{ invalid") }),
        [T3_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"local"}') }),
      }),
    ).toEqual({ projectFile: null, projectFilePending: false });
  });

  it("keeps truncated verne.json authoritative and settled", () => {
    expect(
      resolveMobileProjectFileDefault({
        [VERNE_PROJECT_FILE_NAME]: query({
          data: data('{"defaultThreadEnvMode":"worktree"}', true),
        }),
        [T3_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"local"}') }),
      }),
    ).toEqual({ projectFile: null, projectFilePending: false });
  });

  it("keeps unreadable verne.json authoritative and settled", () => {
    expect(
      resolveMobileProjectFileDefault({
        [VERNE_PROJECT_FILE_NAME]: query({
          error: "Failed to read workspace file.",
          failureCause: readFailure(VERNE_PROJECT_FILE_NAME, {
            operation: "realpath-target",
            code: "EACCES",
          }),
        }),
        [T3_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"local"}') }),
      }),
    ).toEqual({ projectFile: null, projectFilePending: false });
  });

  it("keeps the default pending while the authoritative candidate is loading", () => {
    expect(
      resolveMobileProjectFileDefault({
        [VERNE_PROJECT_FILE_NAME]: query({ isPending: true }),
        [T3_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"local"}') }),
      }),
    ).toEqual({ projectFile: null, projectFilePending: true });
  });

  it("keeps a cached project-file default pending while its authoritative query refreshes", () => {
    expect(
      resolveMobileProjectFileDefault({
        [VERNE_PROJECT_FILE_NAME]: query({
          data: data('{"defaultThreadEnvMode":"worktree"}'),
          isPending: true,
        }),
        [T3_PROJECT_FILE_NAME]: query({ data: data('{"defaultThreadEnvMode":"local"}') }),
      }),
    ).toEqual({ projectFile: "worktree", projectFilePending: true });
  });
});
