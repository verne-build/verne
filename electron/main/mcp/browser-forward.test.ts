import { describe, it, expect } from "vitest";
import { buildBrowserRequest } from "./browser-forward";

describe("browser request shaping", () => {
  it("injects secret + workspaceDir and maps id→tabId", () => {
    const req = buildBrowserRequest(
      { action: "navigate", tabId: "t1", url: "https://x" },
      "secret-x",
      "/ws",
    );
    expect(req).toEqual({ action: "navigate", tabId: "t1", url: "https://x", secret: "secret-x", workspaceDir: "/ws" });
  });
});
