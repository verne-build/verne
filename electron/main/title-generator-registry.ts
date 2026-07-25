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
   *  removes shell quoting from the design and sidesteps the ~256KB argv cap. */
  args: (opts: { cwd: string; outFile: string }) => string[];
  /** Written to the child's stdin. */
  instruction: (prompt: string) => string;
}

const CODEX: TitleGenerator = {
  binaryName: "codex",
  timeoutMs: 20_000,
  args: ({ cwd, outFile }) => [
    "exec",
    "--ephemeral", // else every title generation litters `codex resume`
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "-o",
    outFile, // final message only; no JSONL parsing
  ],
  instruction: (prompt) =>
    "Summarize the following request as a short session title: at most 6 words, " +
    "no trailing period, no quotes, no preamble. Reply with the title only.\n\n" +
    prompt,
};

const GENERATORS: Record<string, TitleGenerator> = { codex: CODEX };

export function titleGeneratorFor(agentType: string | undefined): TitleGenerator | undefined {
  if (!agentType) return undefined;
  return GENERATORS[agentType];
}
