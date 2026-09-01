import { PRODUCT_BASE_NAME } from "@t3tools/shared/productIdentity";
import { decodeUpstreamProvenance, resolveBuildRevision } from "@t3tools/shared/releaseIdentity";

import upstreamJson from "../../../config/verne-upstream.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

declare const __VERNE_BUILD_REVISION__: string;

export const upstreamProvenance = decodeUpstreamProvenance(upstreamJson);

export const buildIdentity = {
  product: PRODUCT_BASE_NAME,
  version: packageJson.version,
  revision: resolveBuildRevision({
    explicitRevision:
      typeof __VERNE_BUILD_REVISION__ === "undefined" ? undefined : __VERNE_BUILD_REVISION__,
  }),
  upstream: upstreamProvenance,
} as const;
