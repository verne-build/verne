export type ReviewAgent = string;

/** The bare interactive launch command for an agent — no inline prompt, so the
 * spawned terminal's shell line stays clean (just `claude`). The review prompt
 * is pasted into the agent's TUI once it's up. */
export function bareLaunchCommand(agent: ReviewAgent): string {
  if (agent === "cursor") return "cursor-agent";
  return agent;
}

/** Wrap text in terminal bracketed-paste markers so a multi-line prompt is
 * ingested by the agent's TUI as a single pasted block (embedded newlines don't
 * submit early). Follow with a carriage return to actually submit. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
