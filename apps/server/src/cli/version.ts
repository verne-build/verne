import { PRODUCT_BASE_NAME } from "@t3tools/shared/productIdentity";
import {
  decodeUpstreamProvenance,
  formatBuildIdentity,
  resolveBuildRevision,
} from "@t3tools/shared/releaseIdentity";
import * as Console from "effect/Console";
import { Command, Flag } from "effect/unstable/cli";

import upstreamJson from "../../../../config/verne-upstream.json" with { type: "json" };
import packageJson from "../../package.json" with { type: "json" };

declare const __VERNE_BUILD_REVISION__: string;

export const upstreamProvenance = decodeUpstreamProvenance(upstreamJson);

export const createVersionReport = (revision: string | undefined) => ({
  product: PRODUCT_BASE_NAME,
  version: packageJson.version,
  revision: resolveBuildRevision({ explicitRevision: revision }),
  upstream: upstreamProvenance,
});

const versionReport = createVersionReport(
  typeof __VERNE_BUILD_REVISION__ === "undefined" ? undefined : __VERNE_BUILD_REVISION__,
);

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
