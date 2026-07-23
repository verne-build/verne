export interface AgentDefinition {
  type: string;
  label: string;
  bin: string;
}

export const AGENT_REGISTRY: AgentDefinition[] = [
  { type: "claude", label: "Claude", bin: "claude" },
  { type: "codex", label: "Codex", bin: "codex" },
  { type: "copilot", label: "Copilot", bin: "copilot" },
  { type: "opencode", label: "OpenCode", bin: "opencode" },
  { type: "gemini", label: "Gemini", bin: "gemini" },
  { type: "cursor", label: "Cursor", bin: "cursor-agent" },
];

const AVAILABILITY_TTL_MS = 5 * 60 * 1_000;
let cached: { loadedAt: number; agents: AgentDefinition[] } | null = null;
let inFlight: Promise<AgentDefinition[]> | null = null;

export function filterAvailableAgents(available: readonly string[]): AgentDefinition[] {
  const bins = new Set(available);
  return AGENT_REGISTRY.filter((agent) => bins.has(agent.bin));
}

export function loadAvailableAgents(
  fetcher: (bins: string[]) => Promise<{ available: string[] }>,
  now = Date.now(),
): Promise<AgentDefinition[]> {
  if (cached && now - cached.loadedAt <= AVAILABILITY_TTL_MS)
    return Promise.resolve(cached.agents);
  if (inFlight) return inFlight;
  inFlight = fetcher(AGENT_REGISTRY.map((agent) => agent.bin))
    .then(({ available }) => {
      const agents = filterAvailableAgents(available);
      cached = { loadedAt: now, agents };
      return agents;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function resetAgentAvailabilityCacheForTests(): void {
  cached = null;
  inFlight = null;
}
