import type { ScopedThreadRef } from "@t3tools/contracts";

import { useTerminalUiStateStore } from "../terminalUiStateStore";

export function openThreadPorts(
  threadRef: ScopedThreadRef,
  navigateToThread: (threadRef: ScopedThreadRef) => void,
): void {
  useTerminalUiStateStore.getState().setBottomDrawerTab(threadRef, "ports");
  navigateToThread(threadRef);
}
