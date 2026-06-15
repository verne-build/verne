import { toast } from "vue-sonner";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSettings } from "@/composables/useSettings";
import { useSettingsScreen } from "@/composables/useSettingsScreen";
import { stripSpinner } from "@/lib/agentStatus";
import { agentLabel, notifyKind, notifyMessage, type AgentNotifyKind, type AgentNotifyState } from "@/lib/agentNotifications";
import type { TabUpdatedEvent } from "@/types";

const lastState = new Map<string, AgentNotifyState>();

function focusTab(tabId: string): void {
  // Surface the tab even if settings cover the workspace.
  useSettingsScreen().showSettings.value = false;
  const store = useWorkspaceStore();
  for (const [dirId, tabs] of Object.entries(store.terminalTabsByDirectory)) {
    if (!tabs.some((t) => t.id === tabId)) continue;
    if (store.selectedDirectoryId !== dirId) {
      const dir = store.directories.find((d) => d.id === dirId);
      if (dir) store.selectDirectory(dir);
    }
    store.setActiveTab(dirId, tabId);
    break;
  }
}

function showToast(kind: AgentNotifyKind, payload: TabUpdatedEvent): void {
  const store = useWorkspaceStore();
  const tabTitle = stripSpinner(store.tabGroupName(payload.tabId));
  const title = tabTitle || agentLabel(payload.agentType!);
  const description = notifyMessage(kind, payload.agentType!);

  toast(title, {
    description,
    duration: kind === "blocked" ? 15000 : 10000,
    closeButton: true,
    action: {
      label: "View",
      onClick: () => focusTab(payload.tabId),
    },
  });
}

function handleTabUpdated(e: Event): void {
  const payload = (e as CustomEvent<TabUpdatedEvent>).detail;
  if (!payload?.tabId || !payload.agentState) return;
  if (!payload.agentType) return;

  // Record edge state unconditionally — gates below only suppress the toast,
  // never tracking (mirrors native/notifications.ts ordering).
  const prev = lastState.get(payload.tabId);
  lastState.set(payload.tabId, payload.agentState as AgentNotifyState);

  const { settings } = useSettings();
  if (settings.value.notificationsInApp === false) return;
  // Complement OS notifications: in-app only while Verne is the focused window.
  if (!document.hasFocus()) return;

  const kind = notifyKind(prev, payload.agentState as AgentNotifyState);
  if (!kind) return;

  showToast(kind, payload);
}

let wired = false;

export function wireAgentNotifications(): void {
  if (wired) return;
  wired = true;
  window.addEventListener("tab-updated", handleTabUpdated);
}

export function unwireAgentNotifications(): void {
  if (!wired) return;
  wired = false;
  window.removeEventListener("tab-updated", handleTabUpdated);
}

/** Drop edge state for a closed tab (avoids stale prev on respawn). */
export function forgetAgentNotificationTab(tabId: string): void {
  lastState.delete(tabId);
}
