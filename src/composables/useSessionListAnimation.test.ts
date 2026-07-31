// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";

import { useSessionListAnimation, SESSION_ANIM_MS } from "./useSessionListAnimation";

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

describe("useSessionListAnimation", () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.append(el);
    setReducedMotion(false);
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });

  it("arms the attribute before mutating, so the transition is live when rows move", () => {
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
    let armedDuringMutate: string | null = null;
    commit("archive", () => { armedDuringMutate = el.getAttribute("data-anim"); });
    expect(armedDuringMutate).toBe("archive");
  });

  it("clears the attribute once the window elapses", () => {
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
    commit("archive", () => {});
    expect(el.getAttribute("data-anim")).toBe("archive");
    vi.advanceTimersByTime(SESSION_ANIM_MS + 1);
    expect(el.hasAttribute("data-anim")).toBe(false);
  });

  it("extends the window when a second commit lands mid-animation", () => {
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
    commit("archive", () => {});
    vi.advanceTimersByTime(SESSION_ANIM_MS - 10);
    commit("exit", () => {});
    vi.advanceTimersByTime(20);
    expect(el.getAttribute("data-anim")).toBe("exit");
    vi.advanceTimersByTime(SESSION_ANIM_MS);
    expect(el.hasAttribute("data-anim")).toBe(false);
  });

  it("mutates exactly once per commit", () => {
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
    const mutate = vi.fn();
    commit("archive", mutate);
    vi.advanceTimersByTime(SESSION_ANIM_MS + 1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("skips when kind is null", () => {
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
    const mutate = vi.fn();
    commit(null, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(el.hasAttribute("data-anim")).toBe(false);
  });

  it("skips when the scope ref is null", () => {
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(null));
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("skips under prefers-reduced-motion", () => {
    setReducedMotion(true);
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(el.hasAttribute("data-anim")).toBe(false);
  });

  it("skips while the document is hidden", () => {
    setHidden(true);
    const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
    const mutate = vi.fn();
    commit("archive", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(el.hasAttribute("data-anim")).toBe(false);
  });

  it("clears a pending attribute and timer when the scope is disposed", () => {
    const scope = effectScope();
    scope.run(() => {
      const { commit } = useSessionListAnimation(ref<HTMLElement | null>(el));
      commit("archive", () => {});
    });
    expect(el.getAttribute("data-anim")).toBe("archive");
    scope.stop();
    expect(el.hasAttribute("data-anim")).toBe(false);
  });
});
