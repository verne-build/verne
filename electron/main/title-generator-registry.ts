// Per-agent title generators. Mirrors resume-registry.ts: the manifest declares
// THAT an agent wants a generated title, this maps agentType → HOW to generate
// one. Adding an agent is one entry here plus one TOML line — no new code paths.
//
// Pure data: no spawning, no fs, so it stays trivially testable.

export interface TitleGenerator {
  /** Looked up through agent-binary.ts, never spawned bare off PATH. */
  binaryName: string;
  timeoutMs: number;
  /** argv AFTER the binary. The prompt is never here — it goes to stdin, which
   *  removes shell quoting from the design and sidesteps the ~256KB argv cap.
   *  `attempt` is 0 for the fast pinned run, 1 for the one retry (see below). */
  args: (opts: { cwd: string; outFile: string; attempt: number }) => string[];
  /** Attempts before giving up. >1 exists only so a model pin that the account
   *  can't use (400) degrades to the user's default instead of freezing the
   *  session at the raw-prompt fallback. */
  attempts: number;
  /** Written to the child's stdin. */
  instruction: (prompt: string) => string;
}

const CODEX: TitleGenerator = {
  binaryName: "codex",
  // Measured `codex exec` round-trips on a real ~/.codex (MCP servers, hooks,
  // AGENTS.md, skills all loaded) run 6–35s. 20s silently fell back to the raw
  // prompt on the slow tail — and the fallback is frozen, so it never recovers.
  timeoutMs: 45_000,
  attempts: 2,
  args: ({ cwd, outFile, attempt }) => [
    "exec",
    "--ephemeral", // else every title generation litters `codex resume`
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "-o",
    outFile, // final message only; no JSONL parsing
    // No MCP servers: a one-line summarize can't use a tool, so every server's
    // tool definitions are pure prompt bloat (~4k tokens here) plus process
    // spawns. Applies to both attempts — it's never the reason a run fails.
    "-c",
    "mcp_servers={}",
    // Attempt 0 pins the fastest model with reasoning off: measured ~6s vs
    // 23-37s on the account default (gpt-5.6-sol @ medium) for the same title,
    // and reasoning buys nothing on a one-line summarize. Attempt 1 drops the
    // pin entirely, so an account that can't use this slug or effort level
    // (the API 400s on either) still gets a real title instead of freezing at
    // the raw-prompt fallback.
    ...(attempt === 0
      ? ["-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="none"']
      : []),
  ],
  instruction: (prompt) =>
    "Summarize the following request as a short session title: at most 8 words, " +
    "sentence case (capitalize only the first word and proper nouns — NOT Title Case), " +
    "no trailing period, no quotes, no preamble. Reply with the title only.\n\n" +
    prompt,
};

const GENERATORS: Record<string, TitleGenerator> = { codex: CODEX };

export function titleGeneratorFor(agentType: string | undefined): TitleGenerator | undefined {
  if (!agentType) return undefined;
  return GENERATORS[agentType];
}
