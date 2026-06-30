export type ReviewAgent = string;

/** How an agent's TUI accepts a pasted prompt.
 *  - "buffered": queues keystrokes through its own boot, so we can paste the
 *    instant bracketed-paste mode turns on and submit promptly — no waiting for
 *    the render to settle, no read-back (codex; this keeps it feeling instant).
 *  - "settle" (default): silently drops input until its composer mounts (claude
 *    flips bracketed-paste mode ~0.3s early), so wait for the boot render to go
 *    quiet and confirm the paste actually landed before submitting. */
export type PasteReadiness = "buffered" | "settle";

/** Per-agent launch config. `bin` is the interactive binary to run; `prefillFlag`
 * (when set) is a native non-submitting seed flag for that agent — left unset so
 * every agent uses the universal paste path. Add a flag only after confirming the
 * agent starts interactively seeded (not print-and-exit). `noUpdateEnv` disables
 * the agent's self-updater: a pending update otherwise blocks startup for ~10s
 * AND its "update available" prompt swallows the pasted review. */
interface AgentLaunch {
  bin: string;
  prefillFlag?: string;
  noUpdateEnv?: Record<string, string>;
  pasteReadiness?: PasteReadiness;
}

const AGENT_LAUNCH: Record<string, AgentLaunch> = {
  claude: { bin: "claude", noUpdateEnv: { DISABLE_AUTOUPDATER: "1" }, pasteReadiness: "settle" },
  codex: { bin: "codex", noUpdateEnv: { CODEX_CI: "1" }, pasteReadiness: "buffered" },
  cursor: { bin: "cursor-agent" },
};

function launchFor(agent: ReviewAgent): AgentLaunch {
  return AGENT_LAUNCH[agent] ?? { bin: agent };
}

/** Per-agent paste behaviour; defaults to the safe "settle" path for agents we
 *  haven't characterised. */
export function pasteReadiness(agent: ReviewAgent): PasteReadiness {
  return launchFor(agent).pasteReadiness ?? "settle";
}

/** The interactive launch command for an agent — no inline prompt, so the
 * spawned terminal's shell line stays clean (the review prompt is pasted into
 * the agent's TUI once it's up). Update-suppression vars are prefixed via `env`
 * (not `VAR=val cmd`, which fish doesn't accept) so the agent never self-updates
 * mid-launch. */
export function bareLaunchCommand(agent: ReviewAgent): string {
  const { bin, noUpdateEnv } = launchFor(agent);
  const assigns = Object.entries(noUpdateEnv ?? {}).map(([k, v]) => `${k}=${v}`);
  return assigns.length ? `env ${assigns.join(" ")} ${bin}` : bin;
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
