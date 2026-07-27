// Shared running-process confirm for terminals that are KILLED outright (bottom
// panel scratch terminals have no archive fallback). One implementation for the
// three surfaces that can end them — pane menu/X, ⌘W, and the bottom tab bar —
// so their copy and their aggregation rules can't drift.
import { ask } from "@/platform";
import { useRpc } from "@/composables/useRpc";
import { useWorkspaceStore } from "@/stores/workspace";

/** What a terminal is running, for confirm copy: agent name, else the
 *  foreground command, else a generic lowercase noun. */
export function runningProcessLabel(tabId: string): string {
  const store = useWorkspaceStore();
  const rt = store.tabRuntime.get(tabId);
  let lastAgentType: string | null | undefined;
  for (const tabs of Object.values(store.terminalTabsByDirectory)) {
    const t = tabs.find((x) => x.id === tabId);
    if (t) {
      lastAgentType = t.lastAgentType;
      break;
    }
  }
  const agent = rt?.agentType ?? lastAgentType;
  if (agent) return agent.charAt(0).toUpperCase() + agent.slice(1);
  return rt?.foregroundCommand || "a process";
}

/** Confirm killing `tabIds`, aggregated over every one still running a
 *  foreground child. True = go ahead (also when nothing is running). */
export async function confirmCloseTerminals(
  tabIds: string[],
  title = "Close Terminal?",
): Promise<boolean> {
  const rpc = useRpc();
  const flags = await Promise.all(
    tabIds.map((id) => rpc.request.tabsHasRunningChild({ id }).catch(() => false)),
  );
  const names = tabIds.filter((_, i) => flags[i]).map(runningProcessLabel);
  if (!names.length) return true;
  const summary =
    names.length === 1 ? `${names[0]} is still running.` : `${names.join(", ")} are still running.`;
  return await ask(title, {
    detail: `${summary} Closing kills ${names.length === 1 ? "it" : "them"}.`,
    confirmLabel: "Close",
  });
}
