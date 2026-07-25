import { describe, it, expect } from "vitest";
import { titleGeneratorFor } from "./title-generator-registry";

describe("titleGeneratorFor", () => {
  it("has no generator for an unknown or missing agent type", () => {
    expect(titleGeneratorFor("claude")).toBeUndefined();
    expect(titleGeneratorFor(undefined)).toBeUndefined();
  });

  it("codex runs `exec` ephemerally and read-only", () => {
    const gen = titleGeneratorFor("codex")!;
    const args = gen.args({ cwd: "/repo", outFile: "/tmp/out.txt" });
    expect(args[0]).toBe("exec");
    // --ephemeral is REQUIRED: without it every generated title litters the
    // `codex resume` picker with a junk session.
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--skip-git-repo-check");
    expect(args.join(" ")).toContain("-s read-only");
    expect(args.join(" ")).toContain("-C /repo");
    expect(args.join(" ")).toContain("-o /tmp/out.txt");
    // The prompt must NOT be in argv — it goes to stdin.
    expect(args.join(" ")).not.toContain("Summarize");
  });

  it("codex instruction asks for a bare title and carries the prompt", () => {
    const gen = titleGeneratorFor("codex")!;
    const text = gen.instruction("add a retry to the uploader");
    expect(text).toContain("add a retry to the uploader");
    expect(text.toLowerCase()).toContain("title only");
  });
});
