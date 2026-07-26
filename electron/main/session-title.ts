// One-shot generated session titles. Policy only — every side effect is injected
// (see archive-session.ts for the same shape), so the whole decision tree is
// unit-testable without spawning a process or touching SQLite.
//
// Contract: exactly ONE title per session. `tabs.generated_title` being non-null
// IS the freeze flag, so no extra state is needed and there is no regeneration.

import type { Tab } from "../../src/types/shared";
import type { TitleGenerator } from "./title-generator-registry";

export interface TitleRequest {
  tabId: string;
  agentType?: string;
  /** Binary path the hook resolved inside the agent's own environment. */
  agentBin?: string | null;
  prompt: string;
  /** Pre-normalized by the daemon (its normalize_title + manifest max_length),
   *  so truncation rules live in exactly one place. Null under bare `generated`. */
  fallbackTitle?: string | null;
}

export interface SessionTitleDeps {
  getTab: (id: string) => Tab | undefined;
  setGeneratedTitle: (id: string, title: string) => void;
  generatorFor: (agentType: string | undefined) => TitleGenerator | undefined;
  /** Raw generated text, or null on ANY failure (exit code, timeout, no binary). */
  runGenerator: (input: {
    generator: TitleGenerator;
    agentBin?: string | null;
    cwd: string;
    prompt: string;
  }) => Promise<string | null>;
  emit: (name: string, payload: unknown) => void;
}

const DEFAULT_MAX_LENGTH = 120;

/** Coerce raw model output into a title: unwrap quotes, collapse whitespace,
 *  cap length. Null when nothing usable is left. */
export function normalizeGeneratedTitle(
  raw: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string | null {
  let text = raw.replace(/\s+/g, " ").trim();
  // Models like to answer with a quoted string despite being told not to.
  while (text.length >= 2 && /^["'`]/.test(text) && text.at(-1) === text[0]) {
    text = text.slice(1, -1).trim();
  }
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function createSessionTitleGeneration(deps: SessionTitleDeps) {
  /** Tabs with a generator running. A second prompt seconds later must not
   *  spawn a second process. */
  const inFlight = new Set<string>();

  async function handle(req: TitleRequest): Promise<void> {
    if (inFlight.has(req.tabId)) return;

    // handle() must NEVER reject — it's called fire-and-forget from an event
    // listener. getTab/generatorFor are injected and could throw (e.g. a DB
    // hiccup); treat that the same as "can't proceed", not an escaping error.
    let tab: Tab | undefined;
    try {
      tab = deps.getTab(req.tabId);
    } catch (e) {
      console.error("[session-title] getTab failed:", e);
      return;
    }
    if (!tab) return; // tab deleted
    if (tab.generatedTitle != null) return; // already titled — frozen

    let generator: TitleGenerator | undefined;
    try {
      generator = deps.generatorFor(req.agentType);
    } catch (e) {
      console.error("[session-title] generatorFor failed:", e);
      return;
    }
    if (!generator) return; // agent has no generator

    inFlight.add(req.tabId);
    try {
      let title: string | null = null;
      try {
        const raw = await deps.runGenerator({
          generator,
          agentBin: req.agentBin,
          cwd: tab.cwd,
          prompt: req.prompt,
        });
        if (raw != null) title = normalizeGeneratedTitle(raw);
      } catch {
        title = null; // never let a generator throw escape
      }
      // Failure falls back to the daemon-normalized prompt. Same column, so the
      // result is equally frozen — this is the "no retry" decision.
      if (title == null) {
        console.warn(`[session-title] generation failed for tab ${req.tabId}; falling back`);
      }
      const finalTitle = title ?? req.fallbackTitle ?? null;
      if (!finalTitle) return; // bare `generated`: stay at agent name
      try {
        deps.setGeneratedTitle(req.tabId, finalTitle);
      } catch (e) {
        // Nothing was written, so the column is still null and a later prompt
        // will try again. The only retry path in the design.
        console.error("[session-title] persist failed:", e);
        return;
      }
      // The DB write already succeeded at this point — a broadcast failure
      // (e.g. webContents.send throwing on a destroyed window) must not undo
      // the write or escape as a rejection. Log and move on.
      try {
        deps.emit("tab-title-generated", { tabId: req.tabId, title: finalTitle });
      } catch (e) {
        console.error("[session-title] emit failed:", e);
      }
    } finally {
      inFlight.delete(req.tabId);
    }
  }

  return { handle };
}
