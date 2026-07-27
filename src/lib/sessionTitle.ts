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
