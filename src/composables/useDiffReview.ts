import { shallowRef, triggerRef } from "vue";
import { toast } from "vue-sonner";
import type { ReviewComment, ReviewContext } from "@/types/shared";
import { useRpc } from "./useRpc";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSettings } from "./useSettings";
import { sendTextToSession } from "./useTerminal";
import { filterCommentsForFile, toAnnotations } from "@/lib/reviewAnnotations";
import { formatReviewPrompt } from "@/lib/reviewPrompt";
import { bareLaunchCommand, bracketedPaste } from "@/lib/reviewLaunch";

// scopeKey -> comments
const byScope = shallowRef(new Map<string, ReviewComment[]>());
const loaded = new Set<string>();
// scopeKey -> the tab id we spawned for its review
const reviewTabByScope = new Map<string, string>();

function trigger() { triggerRef(byScope); }
function get(scopeKey: string): ReviewComment[] { return byScope.value.get(scopeKey) ?? []; }
function set(scopeKey: string, list: ReviewComment[]) { byScope.value.set(scopeKey, list); trigger(); }

async function sendWhenReady(sessionId: string, text: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (sendTextToSession(sessionId, text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Paste a (possibly multi-line) prompt into a live agent's TUI, then submit.
 * Bracketed paste makes the agent treat the whole prompt as one pasted block so
 * its embedded newlines don't submit it line-by-line. Trailing whitespace is
 * trimmed so the closing Enter submits instead of just adding a blank line, and
 * the Enter is sent after a short settle so it isn't swallowed by the paste. */
async function sendPrompt(sessionId: string, prompt: string): Promise<boolean> {
  if (!(await sendWhenReady(sessionId, bracketedPaste(prompt.replace(/\s+$/, ""))))) return false;
  await new Promise((r) => setTimeout(r, 200));
  return sendTextToSession(sessionId, "\r");
}

export function useDiffReview() {
  const { request } = useRpc();

  async function loadScope(scopeKey: string) {
    if (loaded.has(scopeKey)) return;
    loaded.add(scopeKey);
    const list = await request.reviewList({ scopeKey });
    set(scopeKey, list);
  }

  async function reloadScope(scopeKey: string) {
    const list = await request.reviewList({ scopeKey });
    set(scopeKey, list);
  }

  function commentById(id: string): ReviewComment | undefined {
    for (const list of byScope.value.values()) {
      const hit = list.find((c) => c.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  async function addComment(input: Omit<ReviewComment, "id" | "createdAt" | "updatedAt">): Promise<string> {
    const now = Date.now();
    const comment: ReviewComment = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    set(comment.scopeKey, [...get(comment.scopeKey), comment]);
    try {
      await request.reviewUpsert({ comment });
    } catch (e) {
      await reloadScope(comment.scopeKey);
      throw e;
    }
    return comment.id;
  }

  async function updateComment(id: string, body: string) {
    const existing = commentById(id);
    if (!existing) return;
    const updated: ReviewComment = { ...existing, body, updatedAt: Date.now() };
    set(updated.scopeKey, get(updated.scopeKey).map((c) => (c.id === id ? updated : c)));
    try {
      await request.reviewUpsert({ comment: updated });
    } catch (e) {
      await reloadScope(updated.scopeKey);
      throw e;
    }
  }

  async function removeComment(id: string) {
    const existing = commentById(id);
    if (!existing) return;
    set(existing.scopeKey, get(existing.scopeKey).filter((c) => c.id !== id));
    try {
      await request.reviewRemove({ id });
    } catch (e) {
      await reloadScope(existing.scopeKey);
      throw e;
    }
  }

  async function clearScope(scopeKey: string) {
    const prev = get(scopeKey);
    set(scopeKey, []);
    try {
      await request.reviewClearScope({ scopeKey });
    } catch (e) {
      set(scopeKey, prev);
      throw e;
    }
  }

  function commentsForFile(scopeKey: string, ctx: ReviewContext): ReviewComment[] {
    byScope.value; // reactive dep
    return filterCommentsForFile(get(scopeKey), ctx);
  }

  /** All pending comments in a scope (for the navigator), newest diff order. */
  function commentsInScope(scopeKey: string): ReviewComment[] {
    byScope.value;
    return [...get(scopeKey)].sort((a, b) =>
      a.relPath === b.relPath ? a.startLine - b.startLine : a.relPath.localeCompare(b.relPath));
  }

  /** relPath -> pending source-control comment count, for the changed-files list. */
  function fileCommentCounts(scopeKey: string): Record<string, number> {
    byScope.value;
    const counts: Record<string, number> = {};
    for (const c of get(scopeKey)) {
      if (c.source !== "sourceControl") continue;
      counts[c.relPath] = (counts[c.relPath] ?? 0) + 1;
    }
    return counts;
  }

  function annotationsForFile(scopeKey: string, ctx: ReviewContext) {
    return toAnnotations(commentsForFile(scopeKey, ctx));
  }

  function scopeSummary(scopeKey: string): { total: number; files: number } {
    byScope.value;
    const list = get(scopeKey);
    return { total: list.length, files: new Set(list.map((c) => c.relPath)).size };
  }

  /** Poll until the tab has a foreground child (the launched agent) rather than
   * just the bare shell, so we don't paste before the agent's TUI is up. */
  async function waitForAgent(tabId: string, timeoutMs = 12000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await request.tabsHasRunningChild({ id: tabId }).catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  /** Build the prompt and spawn-or-reuse the review tab for `scopeKey`. The
   * prompt is pasted into the agent (not passed as a noisy shell arg); comments
   * are only cleared once it has actually been delivered. */
  async function requestChanges(scopeKey: string, directoryId: string, cwd: string, overall?: string) {
    const list = get(scopeKey);
    if (list.length === 0) return;
    const prompt = formatReviewPrompt(list, overall);
    const agent = useSettings().settings.value.reviewAgent ?? "claude";

    // Reuse a live review tab (one with a running agent) if we have one.
    const existingTabId = reviewTabByScope.get(scopeKey);
    if (existingTabId) {
      const alive = await request.tabsHasRunningChild({ id: existingTabId }).catch(() => false);
      if (alive) {
        const sessionId = await request.tabsSessionId({ id: existingTabId });
        if (sessionId && (await sendPrompt(sessionId, prompt))) {
          await clearScope(scopeKey);
          return;
        }
      }
      reviewTabByScope.delete(scopeKey);
    }

    // Spawn a fresh tab and launch the agent BARE (keeps the shell line clean —
    // just `claude`), wait for it to come up, then paste the review prompt in.
    const store = useWorkspaceStore();
    const tab = await store.createTab({ directoryId, cwd, label: "Suggested changes" });
    const sessionId = await request.tabsSessionId({ id: tab.id });
    if (!sessionId || !(await sendWhenReady(sessionId, bareLaunchCommand(agent) + "\r", 10000))) {
      toast.error("Couldn't start the review agent. Your comments are kept — try Request Changes again.");
      return;
    }
    reviewTabByScope.set(scopeKey, tab.id);
    // Wait for the agent process, then let its TUI settle before pasting.
    if (await waitForAgent(tab.id)) await new Promise((r) => setTimeout(r, 700));
    if (await sendPrompt(sessionId, prompt)) {
      await clearScope(scopeKey);
    } else {
      toast.error("Started the agent but couldn't paste the review. Your comments are kept — focus the new tab and try Request Changes again.");
    }
  }

  return {
    loadScope, addComment, updateComment, removeComment, clearScope,
    commentById, commentsForFile, annotationsForFile, scopeSummary, requestChanges,
    commentsInScope, fileCommentCounts,
  };
}
