import { onUnmounted, watch } from "vue";
import { toast } from "vue-sonner";
import { useAgentInventory } from "@/composables/useAgentInventory";
import { useSettingsNav } from "@/composables/useSettingsNav";
import { useSettingsScreen } from "@/composables/useSettingsScreen";
import type { AgentInventoryItem } from "@/types";

const TOAST_ID = "agent-update-advisory";
const notifiedVersions = new Set<string>();
let started = false;

function descriptionFor(items: AgentInventoryItem[]): string {
  const names = items.map((item) => item.displayName);
  if (names.length === 1) return `${names[0]} has an update available.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} have updates available.`;
  return `Updates are available for ${names.length} agents.`;
}

function show(items: AgentInventoryItem[]): void {
  const newItems = items.filter((item) => {
    if (!item.latestVersion) return false;
    const versionKey = `${item.key}:${item.latestVersion}`;
    if (notifiedVersions.has(versionKey)) return false;
    notifiedVersions.add(versionKey);
    return true;
  });
  if (newItems.length === 0) return;

  toast("Agent Updates Available", {
    id: TOAST_ID,
    description: descriptionFor(newItems),
    action: {
      label: "View Updates",
      onClick: () => {
        useSettingsNav().activeCategory.value = "mcp";
        useSettingsScreen().showSettings.value = true;
      },
    },
  });
}

export function useAgentUpdateAdvisory(): void {
  if (started) return;
  started = true;
  const { snapshot } = useAgentInventory();
  watch(snapshot, (next) => {
    if (!next || next.refreshError !== null) return;
    const expiresAt = Date.parse(next.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    show(next.agents.filter((agent) =>
      agent.discoveryStatus === "installed" && agent.updateStatus === "outdated",
    ));
  }, { immediate: true });
  onUnmounted(() => {
    started = false;
  });
}
