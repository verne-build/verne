import type { Tab } from "../../src/types/shared";
import { resumeCommand } from "./resume-registry";

// Dependency-injected so the ordering/failure semantics are testable without a
// real daemon socket (mirrors archive-session.ts).
export interface ResumeSessionDeps {
  getTab: (id: string) => Tab | null | undefined;
  daemonRequest: <T>(method: string, params: unknown) => Promise<T>;
  /** Build the daemon tab_spawn plan from the persisted row. The optional
   *  second arg OVERRIDES the tab's launch_command. */
  buildPlan: (tab: Tab, launchOverride?: string) => unknown;
}

export interface ResumeSessionOperations {
  /** Respawn an exited session's PTY execing the agent's resume command.
   *  Resolves to the PTY session id. */
  resume(id: string): Promise<string>;
}

/** Resume the agent in a NON-archived session whose PTY is gone (the agent
 *  quit, or the detached daemon was replaced). Archived sessions go through
 *  tabs_unarchive instead, because they additionally own a snapshot blob and
 *  the archived_at flag.
 *
 *  Writes nothing: `archived_at` is already null and the identity columns are
 *  latched, so a failed spawn needs no rollback — the row is still a correct
 *  description of an exited session. */
export function createResumeSessionOperations(deps: ResumeSessionDeps): ResumeSessionOperations {
  async function resume(id: string): Promise<string> {
    const tab = deps.getTab(id);
    if (!tab) throw new Error("tab not found");
    if (tab.archivedAt != null) throw new Error("use tabs_unarchive for archived sessions");

    // Runs AS the shell's exec'd command, REPLACING the tab's own
    // launch_command — otherwise the tab would launch the agent fresh and the
    // resume line would be typed into it.
    const launchOverride = resumeCommand(tab.lastAgentType, tab.lastAgentSessionId);
    if (!launchOverride) throw new Error("resume unavailable");

    // tab_spawn is idempotent (ensure_tab_session returns the existing
    // session), so a redundant call attaches rather than starting a second agent.
    return deps.daemonRequest<string>("tab_spawn", { plan: deps.buildPlan(tab, launchOverride) });
  }

  return { resume };
}
