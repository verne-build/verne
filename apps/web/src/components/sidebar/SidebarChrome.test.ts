import { describe, expect, it } from "vite-plus/test";

import { isPullRequestsRoute, resolveSidebarFooterPage } from "./SidebarChrome";

describe("SidebarChrome navigation state", () => {
  it("keeps the utility footer on the pull requests page", () => {
    expect(resolveSidebarFooterPage("/pull-requests")).toBeNull();
  });

  it("marks only the pull requests route active", () => {
    expect(isPullRequestsRoute("/pull-requests")).toBe(true);
    expect(isPullRequestsRoute("/usage")).toBe(false);
  });

  it("retains back navigation for standalone sidebar pages", () => {
    expect(resolveSidebarFooterPage("/settings/appearance")).toBe("settings");
    expect(resolveSidebarFooterPage("/projects/project-1")).toBe("project-settings");
    expect(resolveSidebarFooterPage("/usage")).toBe("usage");
  });
});
