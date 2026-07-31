import { invoke, listen, type UnlistenFn } from "@/platform";
import { toast } from "vue-sonner";
import { onMounted, onUnmounted } from "vue";

// Stable id — one toast, never a stack.
const TOAST_ID = "daemon-stale";

export function staleToast(): { title: string; opts: Record<string, unknown> } {
  return {
    // No "daemon" in user-facing copy — most users never learn Verne runs one.
    title: "Finish updating Verne",
    opts: {
      id: TOAST_ID,
      description: "Part of the last update needs a quick restart. Your open terminals will close.",
      duration: Infinity,
      closeButton: true,
      action: {
        label: "Restart Now",
        onClick: () => void invoke("daemon_restart_confirm"),
      },
    },
  };
}

/**
 * Prompts when the running daemon is older than the binary on disk. Main fires
 * the check once per launch, so dismissing needs no persisted state — it simply
 * won't reappear until the next launch, and never once the daemon is restarted.
 *
 * Push AND pull, because the ordering isn't guaranteed: main's check is two fast
 * I/O hops while this renderer has a whole bundle to load, so the event usually
 * fires before anything is listening. The mount-time query catches that case;
 * the listener catches the rarer one where we mounted first.
 */
export function useDaemonStaleness(): void {
  let unlisten: UnlistenFn | null = null;
  let shown = false;

  function show(): void {
    if (shown) return; // push + pull can both land; one toast only
    shown = true;
    const { title, opts } = staleToast();
    toast.warning(title, opts);
  }

  onMounted(async () => {
    unlisten = await listen("daemon-stale", show);
    // Already stale before we subscribed? Main cached the verdict.
    try {
      if (await invoke<boolean>("daemon_stale_state")) show();
    } catch { /* main not ready / handler absent → stay silent */ }
  });

  onUnmounted(() => {
    unlisten?.();
    unlisten = null;
  });
}
