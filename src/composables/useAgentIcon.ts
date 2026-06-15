import claudeIconUrl from "@/assets/agents/claude.svg";
import copilotIconUrl from "@/assets/agents/copilot.svg";
import codexIconUrl from "@/assets/agents/codex.png";
import antigravityIconUrl from "@/assets/agents/antigravity.png";
import opencodeDarkUrl from "@/assets/agents/opencode-dark.svg";
import opencodeLightUrl from "@/assets/agents/opencode-light.svg";

// All agent icons live in src/assets/agents/. Unknown types fall back to Claude.
const icons: Record<string, string> = {
  claude: claudeIconUrl,
  copilot: copilotIconUrl,
  codex: codexIconUrl,
  antigravity: antigravityIconUrl,
  opencode: opencodeDarkUrl,
};

// Monochrome/inverted contexts (e.g. light surfaces) — same set, with OpenCode's
// light variant. Others reuse their single asset.
const monoIcons: Record<string, string> = {
  ...icons,
  opencode: opencodeLightUrl,
};

export function getAgentIcon(agentType: string, mono = false): string {
  const map = mono ? monoIcons : icons;
  return map[agentType] ?? map.claude;
}
