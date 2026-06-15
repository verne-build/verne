export function shouldApplyAgentRevision(
  current: number | undefined,
  incoming: number | undefined,
): boolean {
  return incoming == null || current == null || incoming > current;
}

export type DisplayState = "working" | "blocked" | "done" | "idle" | "unknown";

const VALID_STATES: DisplayState[] = ["working", "blocked", "done", "idle", "unknown"];
const GROUP_PRIORITY: DisplayState[] = ["blocked", "done", "working", "idle", "unknown"];

/** Resolve the dot/badge state for a tab. `needsAcknowledgement` (a background
 *  working→idle transition) shows as "done". An unrecognised state maps to
 *  "unknown". When `requireAgentType` is set, a tab with no agent yields null
 *  (no indicator); otherwise the state passes through. */
export function resolveDisplayState(input: {
  needsAcknowledgement?: boolean;
  agentType?: string | null;
  agentState?: string | null;
  requireAgentType?: boolean;
}): DisplayState | null {
  if (input.requireAgentType && !input.agentType) return null;
  if (input.needsAcknowledgement) return "done";
  const s = input.agentState ?? "";
  return (VALID_STATES as string[]).includes(s) ? (s as DisplayState) : "unknown";
}

// Animated loading glyphs agents prepend to their OSC title (Claude's ✳ cycle,
// braille spinners, etc). Noise in any rendered label — strip a leading run of
// them. Falls back to the raw title if the strip would empty it.
const SPINNER_GLYPHS = "·•✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❇❈❉❊❋✢✣✤✥✦✧✨⊛⊕⊙◉◎◍⁂⁕※⍟☼★☆";
const SPINNER_RE = new RegExp(`^[\\s${SPINNER_GLYPHS}\\u2800-\\u28ff]+`);
export function stripSpinner(s: string): string {
  const out = s.replace(SPINNER_RE, "").trim();
  return out || s;
}

/** Collapse a group of pane states into one badge by severity priority. */
export function aggregateGroupState(states: (DisplayState | null)[]): DisplayState | null {
  const present = states.filter((s): s is DisplayState => s != null);
  return GROUP_PRIORITY.find((p) => present.includes(p)) ?? null;
}
