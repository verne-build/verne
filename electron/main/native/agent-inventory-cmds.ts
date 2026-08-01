import type { BrowserWindow } from "electron";
import type { AgentInventoryService } from "../agent-inventory/service";
import { registerNative } from "../ipc-router";

export function registerAgentInventoryCommands(service: AgentInventoryService): void {
  registerNative("agent_inventory_get", () => service.get());
  registerNative("agent_inventory_refresh", () => service.refresh());
}

export function startAgentInventoryAfterWindow(
  create: () => BrowserWindow,
  service: Pick<AgentInventoryService, "refreshIfStale">,
): BrowserWindow {
  const window = create();
  void service.refreshIfStale().catch((error) =>
    console.error("[agent-inventory] startup refresh failed:", error),
  );
  return window;
}

export function refreshInventoryAfterDaemonRestart(
  service: Pick<AgentInventoryService, "refresh"> | null,
): void {
  void service?.refresh().catch((error) =>
    console.error("[agent-inventory] post-restart refresh failed:", error),
  );
}
