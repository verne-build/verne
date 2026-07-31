// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { useSessionListTransition } from "./useSessionListTransition";

type Cb = () => Promise<void> | void;

/** Minimal stand-in for a ViewTransition. `start` drives the update callback so
 *  tests can assert ordering. */
function fakeTransitions() {
  const calls: Cb[] = [];
  let resolveFinished!: () => void;
  let rejectReady!: (reason?: unknown) => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const ready = new Promise<void>((_, reject) => { rejectReady = reject; });
  ready.catch(() => {});
  const start = vi.fn((cb: Cb) => {
    calls.push(cb);
    void cb();
    return { finished, ready };
  });
  return { calls, start, resolveFinished: () => resolveFinished(), rejectReady: (r?: unknown) => rejectReady(r) };
}

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? matches : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

describe("useSessionListTransition", () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.append(el);
    setReducedMotion(false);
    setHidden(false);
    delete (Element.prototype as unknown as Record<string, unknown>).startViewTransition;
    delete (document as unknown as Record<string, unknown>).startViewTransition;
    document.documentElement.removeAttribute("data-vt");
  });
  afterEach(() => {
    el.remove();
    delete (Element.prototype as unknown as Record<string, unknown>).startViewTransition;
    delete (document as unknown as Record<string, unknown>).startViewTransition;
  });

  /** The first commit after creation is always instant, so tests that care
   *  about transitions burn one commit first. */
  function primed(scope = ref<HTMLElement | null>(el)) {
    const { commit } = useSessionListTransition(scope);
    commit("archive", () => {});
    return commit;
  }

  it("mutates synchronously when the API is unavailable", () => {
    const commit = primed();
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("is instant on the first commit after creation", () => {
    const { start } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const { commit } = useSessionListTransition(ref<HTMLElement | null>(el));
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("uses the element-scoped API and runs mutate inside the callback", () => {
    const { start, calls } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(start).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("falls back to the document API when the scoped API is missing", () => {
    const { start } = fakeTransitions();
    (document as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    commit("archive", () => {});
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("sets data-vt on the scope and the root, and clears both when finished", async () => {
    const { start, resolveFinished } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    commit("toggle", () => {});
    expect(el.getAttribute("data-vt")).toBe("toggle");
    expect(document.documentElement.getAttribute("data-vt")).toBe("toggle");
    resolveFinished();
    await Promise.resolve();
    await Promise.resolve();
    expect(el.hasAttribute("data-vt")).toBe(false);
    expect(document.documentElement.hasAttribute("data-vt")).toBe(false);
  });

  it("does not throw when ready rejects, and still mutated", async () => {
    const { start, rejectReady, resolveFinished } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    const mutate = vi.fn();
    commit("archive", mutate);
    rejectReady(new Error("skipped"));
    resolveFinished();
    await Promise.resolve();
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(el.hasAttribute("data-vt")).toBe(false);
  });

  it("skips when kind is null", () => {
    const { start } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    const mutate = vi.fn();
    commit(null, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("skips when the scope ref is null", () => {
    const { start } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed(ref<HTMLElement | null>(null));
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("skips under prefers-reduced-motion", () => {
    const { start } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    setReducedMotion(true);
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("skips while the document is hidden", () => {
    const { start } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    setHidden(true);
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("mutates synchronously while a transition is in flight", () => {
    const { start } = fakeTransitions();
    (Element.prototype as unknown as Record<string, unknown>).startViewTransition = start;
    const commit = primed();
    commit("archive", () => {});
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
