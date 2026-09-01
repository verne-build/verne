import type { APIContext } from "astro";
import { describe, expect, it } from "vite-plus/test";

import { GET } from "../src/pages/schema/verne.json.ts";

describe("GET /schema/verne.json", () => {
  it("publishes the Verne project-file schema", async () => {
    const response = await GET({} as APIContext);
    const schema = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(schema.$id).toBe("https://verne.build/schema/verne.json");
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
  });
});
