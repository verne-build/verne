import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findProjectIcon: vi.fn(),
  projectIconHasTransparentBackground: vi.fn(),
}));

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({ request: {
    findProjectIcon: mocks.findProjectIcon,
    projectIconHasTransparentBackground: mocks.projectIconHasTransparentBackground,
  } }),
}));
vi.mock("@/platform", () => ({ convertFileSrc: (path: string) => `asset:${path}` }));

import { useProjectIcons } from "./useProjectIcons";

describe("useProjectIcons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caches a loaded icon and its transparency by directory", async () => {
    mocks.findProjectIcon.mockResolvedValue("/alpha.png");
    mocks.projectIconHasTransparentBackground.mockResolvedValue(true);
    const { icons, transparentIcons, loadIcon } = useProjectIcons();

    await Promise.all([
      loadIcon("transparent-dir", "/alpha"),
      loadIcon("transparent-dir", "/alpha"),
    ]);

    expect(icons.value["transparent-dir"]).toBe("asset:/alpha.png");
    expect(transparentIcons.value["transparent-dir"]).toBe(true);
    expect(mocks.findProjectIcon).toHaveBeenCalledTimes(1);
    expect(mocks.projectIconHasTransparentBackground).toHaveBeenCalledOnce();
    expect(mocks.projectIconHasTransparentBackground).toHaveBeenCalledWith({ path: "/alpha.png" });
  });

  it("classifies a missing icon as opaque without inspecting it", async () => {
    mocks.findProjectIcon.mockResolvedValue(null);
    const { transparentIcons, loadIcon } = useProjectIcons();

    await loadIcon("missing-dir", "/missing");

    expect(transparentIcons.value["missing-dir"]).toBe(false);
    expect(mocks.projectIconHasTransparentBackground).not.toHaveBeenCalled();
  });

  it("falls back to opaque when icon loading fails", async () => {
    mocks.findProjectIcon.mockRejectedValue(new Error("unavailable"));
    const { transparentIcons, loadIcon } = useProjectIcons();

    await loadIcon("failed-dir", "/failed");

    expect(transparentIcons.value["failed-dir"]).toBe(false);
  });

  it("keeps the icon when transparency inspection fails", async () => {
    mocks.findProjectIcon.mockResolvedValue("/unreadable.png");
    mocks.projectIconHasTransparentBackground.mockRejectedValue(new Error("decode blocked"));
    const { icons, transparentIcons, loadIcon } = useProjectIcons();

    await loadIcon("unreadable-dir", "/unreadable");

    expect(icons.value["unreadable-dir"]).toBe("asset:/unreadable.png");
    expect(transparentIcons.value["unreadable-dir"]).toBe(false);
  });
});
