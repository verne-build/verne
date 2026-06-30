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

  /** Build the prompt and spawn-or-reuse the review tab for `scopeKey`. The
   * prompt is pasted into the agent (not passed as a noisy shell arg); comments
   * are only cleared once it has actually been delivered. */
  async function requestChanges(scopeKey: string, directoryId: string, cwd: string, overall?: string) {
    const list = get(scopeKey);
    if (list.length === 0) return;
    const prompt = formatReviewPrompt(list, overall);
    const agent = useSettings().settings.value.defaultAgent ?? "claude";
    const readiness = pasteReadiness(agent);
    const store = useWorkspaceStore();

    // Reuse a live review tab (one with a running agent) if we have one. Bring
    // it to the foreground first — injection can't reach a backgrounded
    // (unmounted) tab, so without this the paste fails and a duplicate spawns.
    // The agent is already up here, so its composer is ready regardless of kind.
    const existingTabId = reviewTabByScope.get(scopeKey);
    if (existingTabId) {
      const alive = await request.tabsHasRunningChild({ id: existingTabId }).catch(() => false);
      if (alive) {
        const sessionId = await request.tabsSessionId({ id: existingTabId });
        if (sessionId) {
          focusTab(directoryId, existingTabId);
          await waitForPasteReady(sessionId);
          if (await deliverPrompt(sessionId, prompt, readiness)) {
            await clearScope(scopeKey);
            return;
          }
        }
      }
      reviewTabByScope.delete(scopeKey);
    }

    // Spawn a fresh tab and launch the agent BARE (keeps the shell line clean),
    // foreground it so its terminal mounts, wait for the composer, then paste.
    const tab = await store.createTab({ directoryId, cwd, label: "Suggested changes" });
    focusTab(directoryId, tab.id);
    const sessionId = await request.tabsSessionId({ id: tab.id });
    if (!sessionId || !(await sendWhenReady(sessionId, bareLaunchCommand(agent) + "\r", 10000))) {
      toast.error("Couldn't start the review agent. Your comments are kept — try Request Changes again.");
      return;
    }
    reviewTabByScope.set(scopeKey, tab.id);
    // "buffered" agents (codex) queue input through boot — paste the instant
    // bracketed-paste mode is on, so it stays instant. "settle" agents (claude)
    // drop input until the composer mounts, so wait for the boot render to quiet.
    if (readiness === "settle") await waitForComposerReady(sessionId);
    else await waitForPasteReady(sessionId);
    if (await deliverPrompt(sessionId, prompt, readiness)) {
      await clearScope(scopeKey);
    } else {
      toast.error("Started the agent but couldn't confirm the review paste. Your comments are kept — focus the new tab and press Enter, or try Request Changes again.");
    }
  }

  return {
    loadScope, addComment, updateComment, removeComment, clearScope,
    commentById, commentsForFile, annotationsForFile, scopeSummary, requestChanges,
    commentsInScope, fileCommentCounts,
  };
}
