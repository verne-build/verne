import type { AgentLaunchSelection } from "../../src/types/shared";
import { buildAgentArgv, serializeArgv } from "../../src/lib/agentRegistry";

export function resolveLaunchCommand(selection?: AgentLaunchSelection): string | undefined {
  return selection ? serializeArgv(buildAgentArgv(selection)) : undefined;
}
