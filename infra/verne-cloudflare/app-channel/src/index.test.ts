import { describe, expect, it, vi } from "vite-plus/test";
import { readFileSync } from "node:fs";

import { handleAssetRequest } from "./index.ts";

describe("handleAssetRequest", () => {
  it("forwards the request to the static-assets binding", async () => {
    const request = new Request("https://latest.app.verne.build/projects/one?tab=chat");
    const response = new Response("app shell", { status: 200 });
    const fetch = vi.fn(async () => response);

    await expect(handleAssetRequest(request, { ASSETS: { fetch } })).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it("configures the static-assets binding to serve the SPA shell", () => {
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ) as {
      assets: {
        binding: string;
        run_worker_first: boolean;
        not_found_handling: string;
      };
    };

    expect(config.assets.binding).toBe("ASSETS");
    expect(config.assets.run_worker_first).toBe(true);
    expect(config.assets.not_found_handling).toBe("single-page-application");
  });
});
