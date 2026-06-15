import { invoke, listen, type UnlistenFn } from "@/platform";
import { toast } from "vue-sonner";
import { onMounted, onUnmounted } from "vue";

type UpdaterEvent = {
  kind: "checking" | "available" | "not-available" | "progress" | "downloaded" | "error";
  manual?: boolean;
  version?: string;
  percent?: number;
  message?: string;
};

export type UpdateToastResult = { title: string; opts: Record<string, unknown> } | null;

export function updateToast(e: UpdaterEvent): UpdateToastResult {
  switch (e.kind) {
    case "available":
      return { title: "Update available", opts: { description: `Downloading v${e.version}…`, duration: 6000 } };
    case "not-available":
      return e.manual ? { title: "You're up to date", opts: { duration: 4000 } } : null;
    case "downloaded":
      return {
        title: "Update ready",
        opts: {
          description: `v${e.version} will install on restart.`,
          duration: Infinity,
          closeButton: true,
          action: {
            label: "Restart to Update",
            onClick: () => void invoke("updater_quit_and_install"),
          },
        },
      };
    case "error":
      return e.manual ? { title: "Update check failed", opts: { description: e.message, duration: 6000 } } : null;
    default:
      return null; // "checking" / "progress" are silent
  }
}

export function useAppUpdates(): void {
  let unlisten: UnlistenFn | null = null;

  function handle(e: UpdaterEvent): void {
    const result = updateToast(e);
    if (result) toast(result.title, result.opts);
    else if (e.kind === "error" && !e.manual) console.error("[updater]", e.message);
  }

  onMounted(async () => {
    unlisten = await listen<UpdaterEvent>("updater-event", (ev) => handle(ev.payload));
    window.addEventListener("check-for-updates", onMenuCheck);
  });
  onUnmounted(() => {
    unlisten?.();
    unlisten = null;
    window.removeEventListener("check-for-updates", onMenuCheck);
  });
}

function onMenuCheck(): void {
  void invoke("updater_check");
}
