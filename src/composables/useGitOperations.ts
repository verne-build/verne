import { ref, computed } from "vue";
import type { GitStatus } from "@/types";
import { toast } from "vue-sonner";
import { useRpc } from "./useRpc";
import { openExternal } from "@/platform";

export function remoteWebUrl(gitOutput: string): string | null {
  const m = gitOutput.match(/^To\s+(.+)$/m);
  if (!m) return null;
  const url = m[1].trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
  return /^https?:\/\//.test(url) ? url : null;
}

const SC_GIT_TOAST_ID = "sc-git-op";
const SC_GIT_LABELS = {
  pull: { verb: "Pulling", noun: "Pull" },
  push: { verb: "Pushing", noun: "Push" },
  publish: { verb: "Publishing", noun: "Publish" },
} as const;

export function useGitOperations(getRootDir: () => string | undefined) {
  const gitStatus = ref<GitStatus | null>(null);
  const gitBusy = ref<"pull" | "push" | "publish" | null>(null);
  const canPublish = computed(() =>
    !!gitStatus.value?.currentBranch &&
    !!gitStatus.value?.hasRemote &&
    !gitStatus.value?.upstream,
  );
  const canSyncUpstream = computed(() => !!gitStatus.value?.upstream);

  async function runGitCommand(
    action: "pull" | "push" | "publish",
    fn: () => Promise<string>,
  ) {
    if (gitBusy.value || !getRootDir()) return;
    gitBusy.value = action;
    const { verb, noun } = SC_GIT_LABELS[action];
    toast.loading(`${verb}…`, { id: SC_GIT_TOAST_ID, duration: Infinity });
    try {
      const output = await fn();
      const viewUrl = action === "pull" ? null : remoteWebUrl(output);
      // URL lives in the View action; keep it out of the desc.
      const desc = viewUrl
        ? output.replace(/^To\s+.+$/m, "").trim()
        : output;
      toast.success(`${noun} complete`, {
        id: SC_GIT_TOAST_ID,
        description: desc || undefined,
        duration: 4000,
        action: viewUrl
          ? { label: "View", onClick: () => void openExternal(viewUrl) }
          : undefined,
      });
    } catch (e) {
      toast.error(`${noun} failed`, {
        id: SC_GIT_TOAST_ID,
        description: e instanceof Error ? e.message : String(e),
        duration: 8000,
      });
    } finally {
      gitBusy.value = null;
    }
  }

  function pull() {
    const path = getRootDir();
    if (!path) return;
    void runGitCommand("pull", () => useRpc().request.gitPull({ path }));
  }

  function push() {
    const path = getRootDir();
    if (!path) return;
    void runGitCommand("push", () => useRpc().request.gitPush({ path }));
  }

  function publish() {
    const path = getRootDir();
    if (!path) return;
    void runGitCommand("publish", () => useRpc().request.gitPublish({ path }));
  }

  return { gitStatus, gitBusy, canPublish, canSyncUpstream, pull, push, publish };
}
