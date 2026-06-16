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

// One stable toast id so every phase morphs the SAME toast in place instead of
// stacking/expiring separate ones. This is what kills the "nothing happening"
// dead air between download and restart.
const TOAST_ID = "app-update";

export type UpdateToastResult =
  | { type: "loading" | "success" | "error"; title: string; opts: Record<string, unknown> }
  | { type: "dismiss" }
  | null;

function ver(e: UpdaterEvent): string {
  return e.version ? `v${e.version}` : "update";
}

export function updateToast(e: UpdaterEvent): UpdateToastResult {
  switch (e.kind) {
    // Auto checks stay silent until something's found; manual checks show a spinner.
    case "checking":
      return e.manual
        ? { type: "loading", title: "Checking for updates…", opts: { id: TOAST_ID, duration: Infinity } }
        : null;
    case "available":
      return {
        type: "loading",
        title: "Update available",
        opts: { id: TOAST_ID, description: `Downloading ${ver(e)}…`, duration: Infinity },
      };
    case "progress": {
      const pct = e.percent ?? 0;
      // Once bytes are in, electron-updater verifies + stages the package before
      // emitting "downloaded" — a long, silent gap. Flip to an indeterminate
      // "Installing…" spinner so the user sees that work happening.
      return pct >= 100
        ? { type: "loading", title: "Installing update…", opts: { id: TOAST_ID, description: ver(e), duration: Infinity } }
        : {
            type: "loading",
            title: `Downloading ${ver(e)}…`,
            opts: { id: TOAST_ID, description: `${pct}%`, duration: Infinity },
          };
    }
    case "downloaded":
      return {
        type: "success",
        title: "Update ready",
        opts: {
          id: TOAST_ID,
          description: `${ver(e)} will install on restart.`,
          duration: Infinity,
          closeButton: true,
          action: {
            label: "Restart to Update",
            onClick: () => void invoke("updater_quit_and_install"),
          },
        },
      };
    case "not-available":
      return e.manual
        ? { type: "success", title: "You're up to date", opts: { id: TOAST_ID, duration: 4000 } }
        : { type: "dismiss" };
    case "error":
      return e.manual
        ? { type: "error", title: "Update check failed", opts: { id: TOAST_ID, description: e.message, duration: 6000 } }
        : { type: "dismiss" };
    default:
      return null;
  }
}

export function useAppUpdates(): void {
  let unlisten: UnlistenFn | null = null;
  // Progress events carry no version — remember it from "available"/"downloaded".
  let lastVersion: string | undefined;

  function handle(e: UpdaterEvent): void {
    if (e.version) lastVersion = e.version;
    const enriched = e.version ? e : { ...e, version: lastVersion };

    if (e.kind === "error" && !e.manual) console.error("[updater]", e.message);

    const result = updateToast(enriched);
    if (!result) return;
    if (result.type === "dismiss") {
      toast.dismiss(TOAST_ID);
      return;
    }
    const show = result.type === "loading" ? toast.loading : result.type === "success" ? toast.success : toast.error;
    show(result.title, result.opts);
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
