// Resume registry: maps a stored agent type + session id to the shell command
// that resumes that agent when an archived session is brought back to life
// (Task 7 un-archive flow). Extensible: add a template per agent type. Only
// `claude` is seeded today. The session id is shell-QUOTED so an id containing
// a quote can never break out of the command string.

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const RESUME_COMMANDS: Readonly<Record<string, (id: string) => string>> = {
  claude: (id) => `claude --resume ${shellQuote(id)}`,
};

/** Resume command string for a stored agent, or undefined when the agent type
 *  is unknown/unset or no session id was captured. */
export function resumeCommand(agentType?: string, sessionId?: string): string | undefined {
  if (!agentType || !sessionId) return undefined;
  return RESUME_COMMANDS[agentType]?.(sessionId);
}

/** Derived (never persisted): whether an archived tab can be resumed — a
 *  registered template AND a stored session id both exist. */
export function canResumeAgent(agentType?: string, sessionId?: string): boolean {
  return resumeCommand(agentType, sessionId) !== undefined;
}
