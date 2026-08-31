import type { APIRoute } from "astro";

import { VERNE_PROJECT_FILE_SCHEMA_URL } from "@t3tools/shared/productIdentity";
import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";

export const GET: APIRoute = () =>
  new Response(
    `${JSON.stringify(buildT3ProjectFileJsonSchema(VERNE_PROJECT_FILE_SCHEMA_URL), null, 2)}\n`,
    { headers: { "Content-Type": "application/json" } },
  );
