import claudeIconUrl from "@/assets/agents/claude.svg";
import copilotIconUrl from "@/assets/agents/copilot.svg";
import codexDarkIconUrl from "@/assets/agents/codex-dark.svg";
import codexLightIconUrl from "@/assets/agents/codex-light.svg";
import antigravityIconUrl from "@/assets/agents/antigravity.svg";
import opencodeDarkIconUrl from "@/assets/agents/opencode-dark.svg";
import opencodeLightIconUrl from "@/assets/agents/opencode-light.svg";

export type AgentIconSurface = "dark" | "light";

// All agent icons live in src/assets/agents/. Unknown types fall back to Claude.
const darkSurfaceIcons: Record<string, string> = {
  claude: claudeIconUrl,
  copilot: copilotIconUrl,
  codex: codexDarkIconUrl,
  antigravity: antigravityIconUrl,
  opencode: opencodeDarkIconUrl,
};

const lightSurfaceIcons: Record<string, string> = {
  ...darkSurfaceIcons,
  opencode: opencodeLightIconUrl,
  codex: codexLightIconUrl,
};

export function getAgentIconForSurface(agentType: string, surface: AgentIconSurface): string {
  const map = surface === "dark" ? darkSurfaceIcons : lightSurfaceIcons;
  return map[agentType] ?? map.claude;
}

export function agentIconSurfaceForTheme(themeType: "dark" | "light"): AgentIconSurface {
  return themeType === "dark" ? "dark" : "light";
}

export function getAgentIcon(agentType: string, mono = false): string {
  return getAgentIconForSurface(agentType, mono ? "light" : "dark");
}
