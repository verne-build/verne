import { shallowRef, triggerRef } from "vue";
import { toast } from "vue-sonner";
import type { ReviewComment, ReviewContext } from "@/types/shared";
import { useRpc } from "./useRpc";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSettings } from "./useSettings";
import { sendTextToSession, waitForPasteReady, readSessionText } from "./useTerminal";
import { filterCommentsForFile, toAnnotations } from "@/lib/reviewAnnotations";
import { formatReviewPrompt } from "@/lib/reviewPrompt";
import { bareLaunchCommand, bracketedPaste, pasteReadiness, type PasteReadiness } from "@/lib/reviewLaunch";

// scopeKey -> comments
const byScope = shallowRef(new Map<string, ReviewComment[]>());
const loaded = new Set<string>();

function trigger() { triggerRef(byScope); }
function get(scopeKey: string): ReviewComment[] { return byScope.value.get(scopeKey) ?? []; }
function set(scopeKey: string, list: ReviewComment[]) { byScope.value.set(scopeKey, list); trigger(); }
// Comments the user has actually submitted (non-empty body). An empty-body
// comment is an in-progress draft: it renders in the diff so the user can type,
// but must not count toward the bar/badges, be listed, or be sent until saved.
function savedOnly(list: ReviewComment[]): ReviewComment[] {
  return list.filter((c) => c.body.trim().length > 0);
}

async function sendWhenReady(sessionId: string, text: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (sendTextToSession(sessionId, text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Bring a review tab to the foreground. Text injection only reaches a MOUNTED
 * terminal (backgrounded tabs are unmounted + unregistered), so pasting into a
 * non-foreground review tab silently fails — without this the reuse path spins
 * sendWhenReady's full timeout and then spawns a duplicate tab. */
function focusTab(directoryId: string, tabId: string): void {
  const store = useWorkspaceStore();
  const dir = store.directories.find((d) => d.id === directoryId) ?? null;
  store.selectDirectory(dir);
  store.setActiveTab(directoryId, tabId);
}

/** Wait until the agent's composer is genuinely ready for a paste: bracketed-
 * paste mode enabled (DECSET 2004) AND the boot render gone quiet (on-screen
 * text unchanged for `quietMs`). Claude flips 2004 ~0.3s before its input box
 * mounts, so 2004 alone drops the paste; render-quiet adapts to each agent's
 * actual boot (incl. codex's MCP startup). Caps at `timeoutMs`. */
async function waitForComposerReady(
  sessionId: string,
  { quietMs = 1000, timeoutMs = 9000 }: { quietMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  await waitForPasteReady(sessionId, timeoutMs);
  let prev = readSessionText(sessionId);
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 150));
    const cur = readSessionText(sessionId);
    if (cur !== prev) {
      prev = cur;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
  }
}

/** A wrap-proof needle from the prompt: whitespace-stripped leading chunk (soft
 * wraps insert newlines mid-line, so the on-screen text is compared despaced). */
function pasteNeedle(prompt: string): string {
  return prompt.replace(/\s+/g, "").slice(0, 24);
}

/** Has the prompt visibly landed in the composer? Matches the literal text
 * (small pastes / codex inline) OR a collapsed-paste placeholder — claude
 * "[Pasted text … +N lines]" / "paste again to expand"; codex "[Pasted
 * Content …]". */
function pasteLanded(sessionId: string, needle: string): boolean {
  const text = readSessionText(sessionId);
  if (!text) return false;
  if (/\[pasted (?:text|content)/i.test(text) || /paste again to expand/i.test(text)) return true;
  return needle.length > 0 && text.replace(/\s+/g, "").includes(needle);
}

/** Paste a (possibly multi-line) prompt into a live agent's TUI, then submit.
 * Bracketed paste makes the agent ingest the whole prompt as one block so
 * embedded newlines don't submit it line-by-line. The submitting CR is always a
 * SEPARATE write a beat later — claude leaves the prompt editable if paste-end
 * and Enter arrive in the same write.
 *
 * "buffered" agents (codex) reliably queue the paste, so we submit promptly and
 * trust delivery — keeping it instant. "settle" agents (claude) flakily drop
 * input, so we confirm the paste actually landed (literal text or a collapsed
 * placeholder) before submitting and return false without submitting if we
 * can't — we never blind-retry, since a buffering agent would then double. */
async function deliverPrompt(
  sessionId: string,
  prompt: string,
  readiness: PasteReadiness,
): Promise<boolean> {
  const clean = prompt.replace(/\s+$/, "");
  if (!(await sendWhenReady(sessionId, bracketedPaste(clean)))) return false;
  if (readiness === "buffered") {
    await new Promise((r) => setTimeout(r, 200));
    return sendTextToSession(sessionId, "\r");
  }
  const needle = pasteNeedle(clean);
  const start = Date.now();
  while (Date.now() - start < 9000) {
    if (pasteLanded(sessionId, needle)) {
      await new Promise((r) => setTimeout(r, 60));
      return sendTextToSession(sessionId, "\r");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
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
    // Empty-body comment = unsaved draft: keep it local (renders the box) but
    // don't persist until it's given a body via updateComment.
    if (comment.body.trim()) {
      try {
        await request.reviewUpsert({ comment });
      } catch (e) {
        await reloadScope(comment.scopeKey);
        throw e;
      }
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
    return savedOnly(get(scopeKey)).sort((a, b) =>
      a.relPath === b.relPath ? a.startLine - b.startLine : a.relPath.localeCompare(b.relPath));
  }

  /** relPath -> pending source-control comment count, for the changed-files list. */
  function fileCommentCounts(scopeKey: string): Record<string, number> {
    byScope.value;
    const counts: Record<string, number> = {};
    for (const c of get(scopeKey)) {
      if (c.source !== "sourceControl" || !c.body.trim()) continue;
      counts[c.relPath] = (counts[c.relPath] ?? 0) + 1;
    }
    return counts;
  }

  function annotationsForFile(scopeKey: string, ctx: ReviewContext) {
    return toAnnotations(commentsForFile(scopeKey, ctx));
  }

  function scopeSummary(scopeKey: string): { total: number; files: number } {
    byScope.value;
    const list = savedOnly(get(scopeKey));
    return { total: list.length, files: new Set(list.map((c) => c.relPath)).size };
  }

  /** Spawn a fresh tab, foreground it (injection only reaches a mounted
   * terminal), and launch the agent BARE. Returns the tab + session ids, or
   * null if the tab/session couldn't be started. */
  async function launchAgentTab(
    directoryId: string,
    cwd: string | undefined,
    agentType: string,
    label?: string,
  ): Promise<{ tabId: string; sessionId: string } | null> {
    const store = useWorkspaceStore();
    const tab = await store.createTab(label === undefined ? { directoryId, cwd } : { directoryId, cwd, label });
    focusTab(directoryId, tab.id);
    const sessionId = await request.tabsSessionId({ id: tab.id });
    if (!sessionId || !(await sendWhenReady(sessionId, bareLaunchCommand(agentType) + "\r", 10000))) {
      return null;
    }
    return { tabId: tab.id, sessionId };
  }

  /** Spawn a new agent and paste the scope's review into it. */
  async function sendReviewToNewAgent(scopeKey: string, directoryId: string, cwd: string, agentType: string) {
    const list = savedOnly(get(scopeKey));
    if (list.length === 0) return;
    const prompt = formatReviewPrompt(list);
    const readiness = pasteReadiness(agentType);
    const launched = await launchAgentTab(directoryId, cwd, agentType, "Suggested changes");
    if (!launched) {
      toast.error("Couldn't start the agent. Your comments are kept — try again.");
      return;
    }
    if (readiness === "settle") await waitForComposerReady(launched.sessionId);
    else await waitForPasteReady(launched.sessionId);
    if (await deliverPrompt(launched.sessionId, prompt, readiness)) {
      await clearScope(scopeKey);
    } else {
      toast.error("Started the agent but couldn't confirm the paste. Your comments are kept — focus the new tab and press Enter.");
    }
  }

  /** Inject the scope's review into an already-running agent tab. */
  async function sendReviewToTab(scopeKey: string, directoryId: string, tabId: string) {
    const list = savedOnly(get(scopeKey));
    if (list.length === 0) return;
    const prompt = formatReviewPrompt(list);
    const sessionId = await request.tabsSessionId({ id: tabId });
    if (!sessionId) {
      toast.error("That agent tab is no longer available.");
      return;
    }
    const alive = await request.tabsHasRunningChild({ id: tabId }).catch(() => false);
    if (!alive) {
      toast.error("That agent is no longer running. Your comments are kept.");
      return;
    }
    focusTab(directoryId, tabId);
    await waitForPasteReady(sessionId);
    // Running agent: composer already up regardless of kind → "settle" path
    // confirms the paste landed before submitting.
    if (await deliverPrompt(sessionId, prompt, "settle")) {
      await clearScope(scopeKey);
    } else {
      toast.error("Couldn't confirm the paste into that agent. Your comments are kept.");
    }
  }

  return {
    loadScope, addComment, updateComment, removeComment, clearScope,
    commentById, commentsForFile, annotationsForFile, scopeSummary,
    commentsInScope, fileCommentCounts,
    launchAgentTab, sendReviewToNewAgent, sendReviewToTab,
  };
}
