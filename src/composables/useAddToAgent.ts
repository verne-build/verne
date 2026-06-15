import { useWorkspaceStore } from "@/stores/workspace";
import { useRpc } from "@/composables/useRpc";
import { sendTextToSession } from "@/composables/useTerminal";
import { formatPathForShell } from "@/lib/dropPath";

// Inject a path / `path:line` ref into the active agent terminal (selected dir's
// active tab). Mirrors the drag-to-terminal + CodeEditor "Add to Agent" paths.
export async function addToAgent(ref: string): Promise<boolean> {
  const store = useWorkspaceStore();
  const dirId = store.selectedDirectoryId;
  const tabId = dirId ? store.activeTabIdByDirectory[dirId] : undefined;
  if (!tabId) return false;
  const sid = await useRpc().request.tabsSessionId({ id: tabId });
  if (!sid) return false;
  return sendTextToSession(sid, formatPathForShell(ref));
}
