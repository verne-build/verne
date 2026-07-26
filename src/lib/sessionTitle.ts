// Session title precedence, as a pure function so it's testable without Pinia.
// Order matters and is deliberate:
//   1. manual rename        — the user's word is final
//   2. generatedTitle       — the one-shot agent-generated title
//   3. displayTitle         — hook-derived (daemon)
//   4. live OSC title       — what the running program calls itself; this is the
//                             "pending" name while a generated title is in flight
//   5. agent name           — "Codex"
//   6. foreground command
//   7. numbered label

export interface SessionTitleInputs {
  userRenamed?: boolean;
  label?: string;
  generatedTitle?: string;
  displayTitle?: string;
  oscTitle?: string;
  agentType?: string;
  foregroundCommand?: string;
}

export function sessionTitleFrom(inputs: SessionTitleInputs): string {
  if (inputs.userRenamed && inputs.label) return inputs.label;
  if (inputs.generatedTitle) return inputs.generatedTitle;
  if (inputs.displayTitle) return inputs.displayTitle;
  if (inputs.oscTitle) return inputs.oscTitle;
  if (inputs.agentType) {
    return inputs.agentType.charAt(0).toUpperCase() + inputs.agentType.slice(1);
  }
  if (inputs.foregroundCommand) return inputs.foregroundCommand;
  return inputs.label ?? "shell";
}
