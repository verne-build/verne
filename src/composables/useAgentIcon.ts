import claudeIconUrl from "@/assets/agents/claude.svg";
import copilotIconUrl from "@/assets/agents/copilot.svg";
import codexDarkIconUrl from "@/assets/agents/codex-dark.svg";
import codexLightIconUrl from "@/assets/agents/codex-light.svg";
import antigravityIconUrl from "@/assets/agents/antigravity.svg";
import opencodeDarkIconUrl from "@/assets/agents/opencode-dark.svg";
import opencodeLightIconUrl from "@/assets/agents/opencode-light.svg";

// All agent icons live in src/assets/agents/. Unknown types fall back to Claude.
const icons: Record<string, string> = {
  claude: claudeIconUrl,
  copilot: copilotIconUrl,
  codex: codexDarkIconUrl,
  antigravity: antigravityIconUrl,
  opencode: opencodeDarkIconUrl,
};

// Monochrome/inverted contexts (e.g. light surfaces) — same set, with OpenCode's
// light variant. Others reuse their single asset.
const monoIcons: Record<string, string> = {
  ...icons,
  opencode: opencodeLightIconUrl,
  codex: codexLightIconUrl,
};

export function getAgentIcon(agentType: string, mono = false): string {
  const map = mono ? monoIcons : icons;
  return map[agentType] ?? map.claude;
}
