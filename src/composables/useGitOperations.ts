import { ref, computed } from "vue";
import type { InjectionKey } from "vue";
import type { GitStatus } from "@/types";
import { toast } from "vue-sonner";
import { useRpc } from "./useRpc";
import { openExternal, ask } from "@/platform";

export type GitOperations = ReturnType<typeof useGitOperations>;
export const GIT_OPS_KEY: InjectionKey<GitOperations> = Symbol("gitOps");

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
  fetch: { verb: "Fetching", noun: "Fetch" },
  sync: { verb: "Syncing", noun: "Sync" },
  forcePush: { verb: "Force pushing", noun: "Force push" },
  fastForward: { verb: "Fast-forwarding", noun: "Fast-forward" },
} as const;

export type GitAction = keyof typeof SC_GIT_LABELS;

export function useGitOperations(getRootDir: () => string | undefined) {
  const gitStatus = ref<GitStatus | null>(null);
  const gitBusy = ref<GitAction | null>(null);
  const canPublish = computed(() =>
    !!gitStatus.value?.currentBranch &&
    !!gitStatus.value?.hasRemote &&
    !gitStatus.value?.upstream,
  );
  const canSyncUpstream = computed(() => !!gitStatus.value?.upstream);

  async function runGitCommand(
    action: GitAction,
    fn: () => Promise<string>,
  ) {
    if (gitBusy.value || !getRootDir()) return;
    gitBusy.value = action;
    const { verb, noun } = SC_GIT_LABELS[action];
    toast.loading(`${verb}…`, { id: SC_GIT_TOAST_ID, duration: Infinity });
    try {
      const output = await fn();
      const viewUrl = remoteWebUrl(output);
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

  function fetch() {
    const path = getRootDir();
    if (!path) return;
    return runGitCommand("fetch", () => useRpc().request.gitFetch({ path }));
  }

  function sync() {
    const path = getRootDir();
    if (!path) return;
    return runGitCommand("sync", async () => {
      const rpc = useRpc().request;
      const pulled = await rpc.gitPull({ path });
      const pushed = await rpc.gitPush({ path });
      return [pulled, pushed].filter(Boolean).join("\n");
    });
  }

  async function forcePush() {
    const path = getRootDir();
    if (!path || gitBusy.value) return;
    const ok = await ask("Force push to the remote?", {
      detail: "Overwrites remote history using --force-with-lease.",
      confirmLabel: "Force Push",
      kind: "warning",
    });
    if (!ok) return;
    return runGitCommand("forcePush", () => useRpc().request.gitForcePush({ path }));
  }

  function fastForward() {
    const path = getRootDir();
    if (!path) return;
    return runGitCommand("fastForward", () => useRpc().request.gitFastForward({ path }));
  }

  return {
    gitStatus,
    gitBusy,
    canPublish,
    canSyncUpstream,
    pull,
    push,
    publish,
    fetch,
    sync,
    forcePush,
    fastForward,
  };
}
