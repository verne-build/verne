// Session title precedence, as a pure function so it's testable without Pinia.
// Order matters and is deliberate:
//   1. manual rename        — the user's word is final
//   2. generatedTitle       — the one-shot agent-generated title
//   3. displayTitle         — hook-derived, from the LIVE daemon
//   4. storedDisplayTitle   — the last hook-derived title we persisted; only
//                             reached when the daemon no longer has this
//                             session (archived, exited, daemon restarted).
//                             Without it those sessions collapse to "Claude".
//   5. live OSC title       — what the running program calls itself; this is the
//                             "pending" name while a generated title is in flight
//   6. agent name           — "Codex"
//   7. foreground command
//   8. numbered label

export interface SessionTitleInputs {
  archived?: boolean;
  userRenamed?: boolean;
  label?: string;
  generatedTitle?: string;
  displayTitle?: string;
  storedDisplayTitle?: string;
  oscTitle?: string;
  agentType?: string;
  foregroundCommand?: string;
}

export function sessionTitleFrom(inputs: SessionTitleInputs): string {
  if (inputs.userRenamed && inputs.label) return inputs.label;
  if (inputs.generatedTitle) return inputs.generatedTitle;
  if (inputs.displayTitle) return inputs.displayTitle;
  if (inputs.storedDisplayTitle) return inputs.storedDisplayTitle;
  if (inputs.oscTitle) return inputs.oscTitle;
  if (inputs.agentType) {
    return inputs.agentType.charAt(0).toUpperCase() + inputs.agentType.slice(1);
  }
  if (inputs.foregroundCommand) return inputs.foregroundCommand;
  return inputs.label ?? "shell";
}

// Terminal-pane / bottom-tab title. Deliberately NOT sessionTitleFrom: a scratch
// terminal is named by what it is RUNNING, not by an OSC/agent-generated session
// name (zsh configs set the OSC title to the cwd, which reads as noise here).
//   1. manual rename  2. agent name  3. foreground command  4. shell
export interface TerminalTitleInputs {
  userRenamed?: boolean;
  label?: string;
  agentType?: string;
  foregroundCommand?: string;
}

export function terminalTitleFrom(inputs: TerminalTitleInputs): string {
  if (inputs.userRenamed && inputs.label) return inputs.label;
  if (inputs.agentType)
    return inputs.agentType.charAt(0).toUpperCase() + inputs.agentType.slice(1);
  // Login shells report argv0 as "-zsh".
  const cmd = inputs.foregroundCommand?.replace(/^-/, "");
  return cmd || "zsh";
}

/** Visible name for any session: agent-owned sessions use their agent title;
 * ordinary terminals use the process they are running. */
export function sessionDisplayNameFrom(inputs: SessionTitleInputs): string {
  const normalized = inputs.oscTitle
    ? { ...inputs, oscTitle: stripSpinner(inputs.oscTitle) }
    : inputs;
  if (normalized.archived && normalized.storedDisplayTitle)
    return sessionTitleFrom(normalized);
  return normalized.agentType ? sessionTitleFrom(normalized) : terminalTitleFrom(normalized);
}
import { stripSpinner } from "./agentStatus";
