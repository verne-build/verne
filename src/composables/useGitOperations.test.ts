import { describe, it, expect } from "vitest";
import { remoteWebUrl } from "./useGitOperations";

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
