import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";
import {
  type AtomCommandResult,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PreviewTailnetAcquireInput,
  PreviewTailnetAcquireResult,
  PreviewTailnetReleaseInput,
  PreviewTailnetRenewInput,
  PreviewTailnetSetPortEnabledInput,
  PreviewTailnetStatusResult,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);

const unwrap = <A, E = unknown>(result: AtomCommandResult<A, E>): A => {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
};

export const previewTailnetRpc = {
  status: async (environmentId: EnvironmentId): Promise<PreviewTailnetStatusResult> => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      previewEnvironment.tailnetStatus({ environmentId, input: {} }),
      { label: "Tailnet preview status", reportFailure: false },
    );
    return unwrap<PreviewTailnetStatusResult>(result);
  },
  acquire: async (
    environmentId: EnvironmentId,
    input: PreviewTailnetAcquireInput,
  ): Promise<PreviewTailnetAcquireResult> =>
    unwrap<PreviewTailnetAcquireResult>(
      await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.acquireTailnetPreview,
        { environmentId, input },
        { label: "publish Tailnet preview", reportFailure: false },
      ),
    ),
  renew: async (
    environmentId: EnvironmentId,
    input: PreviewTailnetRenewInput,
  ): Promise<PreviewTailnetAcquireResult> =>
    unwrap<PreviewTailnetAcquireResult>(
      await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.renewTailnetPreview,
        { environmentId, input },
        { label: "renew Tailnet preview", reportFailure: false },
      ),
    ),
  release: async (environmentId: EnvironmentId, input: PreviewTailnetReleaseInput) => {
    unwrap<void>(
      await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.releaseTailnetPreview,
        { environmentId, input },
        { label: "release Tailnet preview", reportFailure: false },
      ),
    );
  },
  setPortEnabled: async (
    environmentId: EnvironmentId,
    input: PreviewTailnetSetPortEnabledInput,
  ): Promise<PreviewTailnetStatusResult> =>
    unwrap<PreviewTailnetStatusResult>(
      await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.setTailnetPreviewPortEnabled,
        { environmentId, input },
        { label: `${input.enabled ? "enable" : "disable"} Tailnet preview`, reportFailure: false },
      ),
    ),
};
