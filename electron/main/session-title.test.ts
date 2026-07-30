import { describe, it, expect } from "vitest";
import {
  createSessionTitleGeneration,
  normalizeGeneratedTitle,
  type SessionTitleDeps,
  type TitleRequest,
} from "./session-title";
import type { TitleGenerator } from "./title-generator-registry";
import type { Tab } from "../../src/types/shared";

const GEN: TitleGenerator = {
  binaryName: "codex",
  timeoutMs: 1000,
  attempts: 1,
  args: () => ["exec"],
  instruction: (p) => p,
};

function tab(over: Partial<Tab> = {}): Tab {
  return { id: "t1", directoryId: "d1", label: "1", cwd: "/repo", sortOrder: 0, createdAt: 0, ...over };
}

interface Harness {
  ops: ReturnType<typeof createSessionTitleGeneration>;
  written: Array<{ id: string; title: string }>;
  emitted: Array<{ name: string; payload: unknown }>;
  runs: number;
}

function harness(over: Partial<SessionTitleDeps> = {}, initial: Tab = tab()): Harness {
  const written: Harness["written"] = [];
  const emitted: Harness["emitted"] = [];
  let runs = 0;
  const deps: SessionTitleDeps = {
    getTab: () => initial,
    setGeneratedTitle: (id, title) => { written.push({ id, title }); },
    generatorFor: () => GEN,
    runGenerator: async () => { runs++; return "Retry The Uploader"; },
    emit: (name, payload) => { emitted.push({ name, payload }); },
    ...over,
  };
  const h = { ops: createSessionTitleGeneration(deps), written, emitted, get runs() { return runs; } };
  return h as Harness;
}

const req = (over: Partial<TitleRequest> = {}): TitleRequest => ({
  tabId: "t1",
  agentType: "codex",
  agentBin: "/Users/me/.local/bin/codex",
  prompt: "add a retry to the uploader",
  fallbackTitle: "add a retry to the uploader",
  ...over,
});

describe("createSessionTitleGeneration", () => {
  it("writes the normalized generated title and broadcasts it", async () => {
    const h = harness();
    await h.ops.handle(req());
    expect(h.written).toEqual([{ id: "t1", title: "Retry the uploader" }]);
    expect(h.emitted).toEqual([
      { name: "tab-title-generated", payload: { tabId: "t1", title: "Retry the uploader" } },
    ]);
  });

  it("skips a tab that already has a title — one per session, frozen", async () => {
    const h = harness({}, tab({ generatedTitle: "Existing" }));
    await h.ops.handle(req());
    expect(h.written).toEqual([]);
    expect(h.runs).toBe(0);
  });

  it("skips an agent with no registered generator", async () => {
    const h = harness({ generatorFor: () => undefined });
    await h.ops.handle(req({ agentType: "claude" }));
    expect(h.written).toEqual([]);
  });

  it("skips a vanished tab", async () => {
    const h = harness({ getTab: () => undefined });
    await h.ops.handle(req());
    expect(h.written).toEqual([]);
  });

  it("dedupes a concurrent second prompt — one process, not two", async () => {
    let release: (v: string | null) => void = () => {};
    const h = harness({
      runGenerator: () => new Promise<string | null>((r) => { release = r; }),
    });
    const first = h.ops.handle(req());
    const second = h.ops.handle(req());   // arrives while the first is in flight
    release("Retry The Uploader");
    await Promise.all([first, second]);
    expect(h.written).toHaveLength(1);
  });

  it("falls back to the truncated prompt when generation fails", async () => {
    const h = harness({ runGenerator: async () => null });
    await h.ops.handle(req());
    expect(h.written).toEqual([{ id: "t1", title: "add a retry to the uploader" }]);
    expect(h.emitted).toEqual([
      { name: "tab-title-generated", payload: { tabId: "t1", title: "add a retry to the uploader" } },
    ]);
  });

  it("writes the fallback title byte-identical — never re-normalized or re-truncated", async () => {
    // The daemon already ran normalize_title + manifest max_length on this.
    // Quotes and >120 chars would both be VISIBLY changed by
    // normalizeGeneratedTitle, so a regression that ran the fallback through
    // it (instead of the raw generator output only) would fail this.
    const longFallback = `"${"x".repeat(150)}"`;
    const h = harness({ runGenerator: async () => null });
    await h.ops.handle(req({ fallbackTitle: longFallback }));
    expect(h.written).toEqual([{ id: "t1", title: longFallback }]);
  });

  it("falls back when generation returns only whitespace", async () => {
    const h = harness({ runGenerator: async () => "   \n  " });
    await h.ops.handle(req());
    expect(h.written).toEqual([{ id: "t1", title: "add a retry to the uploader" }]);
  });

  it("writes nothing when generation fails and there is no fallback", async () => {
    // bare `generated` strategy → fallbackTitle is null → stay at the agent name
    const h = harness({ runGenerator: async () => null });
    await h.ops.handle(req({ fallbackTitle: null }));
    expect(h.written).toEqual([]);
    expect(h.emitted).toEqual([]);
  });

  it("retries on a later prompt if persisting threw", async () => {
    let calls = 0;
    const h = harness({
      setGeneratedTitle: () => { calls++; throw new Error("db locked"); },
    });
    await h.ops.handle(req());          // must not reject
    await h.ops.handle(req());          // column still null → tries again
    expect(calls).toBe(2);
  });
});

describe("normalizeGeneratedTitle", () => {
  it("strips surrounding quotes", () => {
    expect(normalizeGeneratedTitle('"Retry the uploader"')).toBe("Retry the uploader");
    expect(normalizeGeneratedTitle("'Retry the uploader'")).toBe("Retry the uploader");
  });

  it("collapses newlines and whitespace", () => {
    expect(normalizeGeneratedTitle("Retry\n  the   uploader\n")).toBe("Retry the uploader");
  });

  it("truncates to the max length", () => {
    expect(normalizeGeneratedTitle("abcdefghij", 4)).toBe("Abcd");
  });

  it("downcases Title Case output", () => {
    expect(normalizeGeneratedTitle("Retry The Failed Uploader")).toBe("Retry the failed uploader");
  });

  it("capitalizes the first word", () => {
    expect(normalizeGeneratedTitle("retry the uploader")).toBe("Retry the uploader");
  });

  it("keeps acronyms, identifiers and known proper nouns", () => {
    expect(normalizeGeneratedTitle("Fix API Timeout In SessionsSidebar.vue")).toBe(
      "Fix API timeout in SessionsSidebar.vue",
    );
    expect(normalizeGeneratedTitle("Add Vue Router Guard")).toBe("Add Vue router guard");
  });

  it("returns null for empty or whitespace-only output", () => {
    expect(normalizeGeneratedTitle("")).toBeNull();
    expect(normalizeGeneratedTitle("  \n ")).toBeNull();
    expect(normalizeGeneratedTitle('""')).toBeNull();
  });
});
