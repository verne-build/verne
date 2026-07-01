import { describe, it, expect, vi, beforeEach } from "vitest";

const gitPull = vi.fn();
const gitPush = vi.fn();
const gitForcePush = vi.fn();
const ask = vi.fn();

vi.mock("./useRpc", () => ({
  useRpc: () => ({ request: { gitPull, gitPush, gitForcePush } }),
}));
vi.mock("@/platform", () => ({
  ask: (...a: unknown[]) => ask(...a),
  openExternal: vi.fn(),
}));
vi.mock("vue-sonner", () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { remoteWebUrl, useGitOperations } from "./useGitOperations";

describe("remoteWebUrl", () => {
  it("converts ssh remote to https url", () => {
    const output = "Enumerating objects: 3, done.\nTo git@github.com:owner/repo.git\n branch -> branch";
    expect(remoteWebUrl(output)).toBe("https://github.com/owner/repo");
  });

  it("returns https url unchanged (minus .git)", () => {
    const output = "To https://github.com/owner/repo.git\n branch -> branch";
    expect(remoteWebUrl(output)).toBe("https://github.com/owner/repo");
  });

  it("returns null when no To line", () => {
    const output = "Everything up-to-date\n";
    expect(remoteWebUrl(output)).toBeNull();
  });

  it("returns null for local mirror path", () => {
    const output = "To /local/mirror.git\n branch -> branch";
    expect(remoteWebUrl(output)).toBeNull();
  });
});

describe("useGitOperations sync", () => {
  beforeEach(() => {
    gitPull.mockReset();
    gitPush.mockReset();
  });

  it("pulls then pushes", async () => {
    gitPull.mockResolvedValue("Updating a..b");
    gitPush.mockResolvedValue("To git@github.com:owner/repo.git");
    const { sync } = useGitOperations(() => "/repo");
    await sync();
    expect(gitPull).toHaveBeenCalledOnce();
    expect(gitPush).toHaveBeenCalledOnce();
  });
});

describe("useGitOperations forcePush", () => {
  beforeEach(() => {
    gitForcePush.mockReset();
    ask.mockReset();
  });

  it("does not force push when the confirm is cancelled", async () => {
    ask.mockResolvedValue(false);
    const { forcePush } = useGitOperations(() => "/repo");
    await forcePush();
    expect(gitForcePush).not.toHaveBeenCalled();
  });

  it("force pushes when confirmed", async () => {
    ask.mockResolvedValue(true);
    gitForcePush.mockResolvedValue("To git@github.com:owner/repo.git");
    const { forcePush } = useGitOperations(() => "/repo");
    await forcePush();
    expect(gitForcePush).toHaveBeenCalledOnce();
  });
});
