import { describe, it, expect } from "vitest";
import { titleGeneratorFor } from "./title-generator-registry";

describe("titleGeneratorFor", () => {
  it("has no generator for an unknown or missing agent type", () => {
    expect(titleGeneratorFor("claude")).toBeUndefined();
    expect(titleGeneratorFor(undefined)).toBeUndefined();
  });

  it("codex runs `exec` ephemerally and read-only", () => {
    const gen = titleGeneratorFor("codex")!;
    const args = gen.args({ cwd: "/repo", outFile: "/tmp/out.txt", attempt: 0 });
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

  it("codex runs with no MCP servers on every attempt", () => {
    // Tool definitions are dead weight for a summarize — and the retry must
    // not silently re-enable them.
    const gen = titleGeneratorFor("codex")!;
    for (const attempt of [0, 1]) {
      const args = gen.args({ cwd: "/repo", outFile: "/tmp/out.txt", attempt });
      expect(args.join(" ")).toContain("-c mcp_servers={}");
    }
  });

  it("codex pins a fast model on attempt 0 and drops the pin on retry", () => {
    const gen = titleGeneratorFor("codex")!;
    const opts = { cwd: "/repo", outFile: "/tmp/out.txt" };
    // Pinned run is the fast path; the retry must be able to succeed on an
    // account where the pinned slug 400s.
    expect(gen.args({ ...opts, attempt: 0 }).join(" ")).toContain("-m gpt-5.6-luna");
    expect(gen.args({ ...opts, attempt: 1 }).join(" ")).not.toContain("-m ");
    expect(gen.attempts).toBe(2);
  });

  it("codex instruction asks for a bare title and carries the prompt", () => {
    const gen = titleGeneratorFor("codex")!;
    const text = gen.instruction("add a retry to the uploader");
    expect(text).toContain("add a retry to the uploader");
    expect(text.toLowerCase()).toContain("title only");
  });
});
