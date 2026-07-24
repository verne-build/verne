import type { AgentLaunchSelection } from "../../src/types/shared";
import { buildAgentArgv, serializeArgv } from "../../src/lib/agentRegistry";

const AGENT_LAUNCH_KEYS = ["agentType", "modelId", "effort", "fast"] as const;

function isAgentLaunchSelection(value: unknown): value is AgentLaunchSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(selection).length !== AGENT_LAUNCH_KEYS.length
    || !AGENT_LAUNCH_KEYS.every((key) => Object.hasOwn(selection, key))
  ) return false;
  return typeof selection.agentType === "string"
    && (selection.modelId === null || typeof selection.modelId === "string")
    && (selection.effort === null || typeof selection.effort === "string")
    && (selection.fast === null || typeof selection.fast === "boolean");
}

export function resolveLaunchCommand(selection?: AgentLaunchSelection): string | undefined {
  if (selection === undefined) return undefined;
  if (!isAgentLaunchSelection(selection)) throw new Error("Invalid agent launch selection");
  return serializeArgv(buildAgentArgv(selection));
}
