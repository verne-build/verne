import { toast } from "vue-sonner";
import { useWorkspaceStore } from "@/stores/workspace";
import { useProjectIcons } from "@/composables/useProjectIcons";
import { useSettings } from "@/composables/useSettings";
import { useSettingsScreen } from "@/composables/useSettingsScreen";
import { agentLabel, notifyKind, notifyMessage, type AgentNotifyKind, type AgentNotifyState } from "@/lib/agentNotifications";
import { projectToastIcon } from "@/lib/projectToastIcon";
import type { TabUpdatedEvent } from "@/types";

const lastState = new Map<string, AgentNotifyState>();

function focusTab(tabId: string): void {
  // Surface the tab even if settings cover the workspace.
  useSettingsScreen().showSettings.value = false;
  // selectSession implements the old semantics: member -> focus in place,
  // non-member -> solo replace, cross-scope -> selectDirectory first.
  useWorkspaceStore().selectSession(tabId);
}

async function showToast(kind: AgentNotifyKind, payload: TabUpdatedEvent): Promise<void> {
  const store = useWorkspaceStore();
  const tabTitle = store.sessionName(payload.tabId);
  const title = tabTitle || agentLabel(payload.agentType!);
  const description = notifyMessage(kind, payload.agentType!);
  const directory = store.directories.find((candidate) =>
    store.terminalTabsByDirectory[candidate.id]?.some((tab) => tab.id === payload.tabId),
  );
  const { icons, transparentIcons, loadIcon } = useProjectIcons();
  if (directory) await loadIcon(directory.id, directory.path);
  const iconSrc = directory ? icons.value[directory.id] : "";
  const iconIsTransparent = directory ? transparentIcons.value[directory.id] ?? false : false;

  toast(title, {
    description,
    ...(iconSrc ? { icon: projectToastIcon(iconSrc, iconIsTransparent) } : {}),
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

  void showToast(kind, payload);
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
