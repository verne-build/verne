import {
  EnvironmentId,
  ProjectReadFileError,
  T3_PROJECT_FILE_NAME,
  VERNE_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const queryStates = vi.hoisted(() => new Map<string, unknown>());

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useMemo: <T>(factory: () => T) => factory() };
});

vi.mock("~/components/files/projectFilesQueryState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/files/projectFilesQueryState")>();
  return {
    ...actual,
    useProjectFileQuery: (_environmentId: string, _cwd: string, fileName: string) =>
      queryStates.get(fileName),
  };
});

import { useT3ProjectFileState } from "./useT3ProjectFileScripts";

const environmentId = EnvironmentId.make("local");
const settled = {
  error: null,
  failureCause: null,
  isPending: false,
  refresh: () => {},
};

function data(contents: string) {
  return {
    relativePath: "project.json",
    contents,
    byteLength: contents.length,
    truncated: false,
  };
}

function missing(fileName: string) {
  const fileSystemError = {
    _tag: "WorkspaceFileSystemOperationError",
    cause: new Error("ENOENT: no such file or directory"),
  };
  const error = new ProjectReadFileError({
    cwd: "/repo",
    relativePath: fileName,
    failure: "operation_failed",
    operation: "realpath-target",
    operationPath: `/repo/${fileName}`,
    cause: fileSystemError,
  });
  return {
    ...settled,
    data: null,
    error: error.message,
    failureCause: Cause.fail(error),
  };
}

function unreadable(fileName: string) {
  const error = new ProjectReadFileError({
    cwd: "/repo",
    relativePath: fileName,
    failure: "operation_failed",
    operation: "realpath-target",
    operationPath: `/repo/${fileName}`,
    cause: new Error("EACCES: permission denied"),
  });
  return {
    ...settled,
    data: null,
    error: error.message,
    failureCause: Cause.fail(error),
  };
}

describe("useT3ProjectFileState", () => {
  beforeEach(() => queryStates.clear());

  it("selects valid verne.json when both project files are valid", () => {
    queryStates.set(VERNE_PROJECT_FILE_NAME, {
      ...settled,
      data: data('{"scripts":[{"name":"Verne","command":"vp verne"}]}'),
    });
    queryStates.set(T3_PROJECT_FILE_NAME, {
      ...settled,
      data: data('{"scripts":[{"name":"T3","command":"vp t3"}]}'),
    });

    expect(useT3ProjectFileState(environmentId, "/repo")).toMatchObject({
      status: "valid",
      fileName: VERNE_PROJECT_FILE_NAME,
      scripts: [{ name: "Verne", command: "vp verne" }],
    });
  });

  it("falls back to valid t3.json when verne.json is missing", () => {
    queryStates.set(VERNE_PROJECT_FILE_NAME, missing(VERNE_PROJECT_FILE_NAME));
    queryStates.set(T3_PROJECT_FILE_NAME, {
      ...settled,
      data: data('{"defaultThreadEnvMode":"local"}'),
    });

    expect(useT3ProjectFileState(environmentId, "/repo")).toMatchObject({
      status: "valid",
      fileName: T3_PROJECT_FILE_NAME,
      file: { defaultThreadEnvMode: "local" },
    });
  });

  it("keeps invalid verne.json authoritative over valid t3.json", () => {
    queryStates.set(VERNE_PROJECT_FILE_NAME, {
      ...settled,
      data: data("{ invalid"),
    });
    queryStates.set(T3_PROJECT_FILE_NAME, {
      ...settled,
      data: data('{"defaultThreadEnvMode":"local"}'),
    });

    expect(useT3ProjectFileState(environmentId, "/repo")).toEqual({
      status: "invalid",
      fileName: VERNE_PROJECT_FILE_NAME,
      file: null,
      scripts: [],
    });
  });

  it("keeps truncated verne.json authoritative over valid t3.json", () => {
    queryStates.set(VERNE_PROJECT_FILE_NAME, {
      ...settled,
      data: { ...data('{"defaultThreadEnvMode":"worktree"}'), truncated: true },
    });
    queryStates.set(T3_PROJECT_FILE_NAME, {
      ...settled,
      data: data('{"defaultThreadEnvMode":"local"}'),
    });

    expect(useT3ProjectFileState(environmentId, "/repo")).toMatchObject({
      status: "invalid",
      fileName: VERNE_PROJECT_FILE_NAME,
      file: null,
    });
  });

  it("keeps unreadable verne.json authoritative over valid t3.json", () => {
    queryStates.set(VERNE_PROJECT_FILE_NAME, unreadable(VERNE_PROJECT_FILE_NAME));
    queryStates.set(T3_PROJECT_FILE_NAME, {
      ...settled,
      data: data('{"defaultThreadEnvMode":"local"}'),
    });

    expect(useT3ProjectFileState(environmentId, "/repo")).toMatchObject({
      status: "invalid",
      fileName: VERNE_PROJECT_FILE_NAME,
    });
  });

  it("keeps loading verne.json authoritative while t3.json is already valid", () => {
    queryStates.set(VERNE_PROJECT_FILE_NAME, {
      ...settled,
      data: null,
      isPending: true,
    });
    queryStates.set(T3_PROJECT_FILE_NAME, {
      ...settled,
      data: data('{"defaultThreadEnvMode":"local"}'),
    });

    expect(useT3ProjectFileState(environmentId, "/repo")).toEqual({
      status: "loading",
      fileName: VERNE_PROJECT_FILE_NAME,
      file: null,
      scripts: [],
    });
  });

  it("uses a null filename when both project files are missing", () => {
    queryStates.set(VERNE_PROJECT_FILE_NAME, missing(VERNE_PROJECT_FILE_NAME));
    queryStates.set(T3_PROJECT_FILE_NAME, missing(T3_PROJECT_FILE_NAME));

    expect(useT3ProjectFileState(environmentId, "/repo")).toEqual({
      status: "missing",
      fileName: null,
      file: null,
      scripts: [],
    });
  });
});
