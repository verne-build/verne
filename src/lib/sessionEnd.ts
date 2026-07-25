// The single terminating action for a session, shared by every surface that
// offers one (sidebar card menu, pane menu, ⌘W / kill-session shortcuts) so they
// can't drift apart.
//
// There is no "close session" any more: archive IS how a live session ends — it
// stops the PTY and keeps a read-only terminal snapshot. Delete is only reachable
// once nothing is live (already archived, or the PTY has exited), so a session
// can still be removed for good rather than piling up forever.

export type SessionEndAction = "archive" | "delete";

export function sessionEndAction(s: { archived: boolean; exited: boolean }): SessionEndAction {
  return s.archived || s.exited ? "delete" : "archive";
}

/** Menu label for the action. Title Case per the project's menu convention. */
export function sessionEndLabel(action: SessionEndAction): string {
  return action === "archive" ? "Archive Session" : "Delete Session";
}

/** Archiving stops a running agent, so confirm first when it's mid-work.
 *  An idle/unknown session archives without a prompt. */
export function shouldConfirmArchive(state: string | undefined): boolean {
  return state === "working" || state === "blocked";
}
