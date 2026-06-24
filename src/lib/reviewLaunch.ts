export type ReviewAgent = string;

/** Per-agent launch config. `bin` is the interactive binary to run; `prefillFlag`
 * (when set) is a native non-submitting seed flag for that agent — left unset so
 * every agent uses the universal paste path. Add a flag only after confirming the
 * agent starts interactively seeded (not print-and-exit). */
interface AgentLaunch {
  bin: string;
  prefillFlag?: string;
}

const AGENT_LAUNCH: Record<string, AgentLaunch> = {
  cursor: { bin: "cursor-agent" },
};

function launchFor(agent: ReviewAgent): AgentLaunch {
  return AGENT_LAUNCH[agent] ?? { bin: agent };
}

/** The bare interactive launch command for an agent — no inline prompt, so the
 * spawned terminal's shell line stays clean (just `claude`). The review prompt
 * is pasted into the agent's TUI once it's up. */
export function bareLaunchCommand(agent: ReviewAgent): string {
  return launchFor(agent).bin;
}

/** Strip any bracketed-paste markers already present in `text` so an embedded
 * end-marker can't terminate the paste early (review prompts are markdown and may
 * contain arbitrary bytes). */
export function sanitizeBracketedPaste(text: string): string {
  return text.replace(/\x1b\[20[01]~/g, "");
}

/** Wrap text in terminal bracketed-paste markers so a multi-line prompt is
 * ingested by the agent's TUI as a single pasted block (embedded newlines don't
 * submit early). Sanitizes first; follow with a carriage return to submit. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${sanitizeBracketedPaste(text)}\x1b[201~`;
}
