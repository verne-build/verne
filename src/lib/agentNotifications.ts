/** Edge-detect agent notification kinds. Mirrors electron/main/native/notifications.ts. */
export type AgentNotifyKind = "blocked" | "finished";

export type AgentNotifyState = "working" | "blocked" | "idle" | "unknown";

// One entry per detection manifest (daemon/crates/core/src/services/agent_status/manifest/manifests/).
const AGENT_LABEL: Record<string, string> = {
  amp: "Amp",
  antigravity: "Antigravity",
  claude: "Claude",
  cline: "Cline",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  droid: "Droid",
  gemini: "Gemini",
  grok: "Grok",
  hermes: "Hermes",
  kilo: "Kilo",
  kimi: "Kimi",
  kiro: "Kiro",
  opencode: "OpenCode",
  pi: "Pi",
  qodercli: "Qoder",
};

export function agentLabel(agentType: string): string {
  return AGENT_LABEL[agentType] ?? agentType;
}

/** Status line — mirrors electron/main/native/notifications.ts OS title. */
export function notifyMessage(kind: AgentNotifyKind, agentType: string): string {
  const agent = agentLabel(agentType);
  return kind === "blocked" ? `${agent} needs your input` : `${agent} finished`;
}

export function notifyKind(
  prev: AgentNotifyState | undefined,
  cur: AgentNotifyState,
): AgentNotifyKind | null {
  if (cur === "blocked" && prev !== "blocked") return "blocked";
  if (cur === "idle" && prev === "working") return "finished";
  return null;
}
