import { formatBuildIdentity, resolveBuildRevision } from "@t3tools/shared/releaseIdentity";
import * as Console from "effect/Console";
import { Command, Flag } from "effect/unstable/cli";

import { buildIdentity } from "../buildIdentity.ts";

export const createVersionReport = (revision: string | undefined) => ({
  ...buildIdentity,
  revision: resolveBuildRevision({ explicitRevision: revision }),
});

const versionReport = buildIdentity;

export const versionCommand = Command.make(
  "version",
  {
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print structured build identity as JSON."),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    Console.log(
      json
        ? JSON.stringify(versionReport, null, 2)
        : formatBuildIdentity({ ...versionReport, upstream: versionReport.upstream }),
    ),
).pipe(Command.withDescription("Show Verne build identity and upstream provenance."));
