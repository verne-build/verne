import { nextTick, type Ref } from "vue";

export type TransitionKind = "archive" | "unarchive" | "enter" | "exit" | "toggle";

/** Subset of ViewTransition we use. TS's DOM lib does not yet type the
 *  element-scoped form, so declare it locally rather than casting at each use. */
interface ViewTransitionLike {
  finished: Promise<void>;
  ready: Promise<void>;
}
type StartViewTransition = (callback: () => Promise<void> | void) => ViewTransitionLike;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Element-scoped first (Chromium 141+): scoping keeps the WebGL terminal
 *  canvas out of the snapshot, so it keeps rendering live instead of freezing
 *  for the duration of every archive. Fall back to the document-level API,
 *  which pairs with `:root { view-transition-name: none }` in style.css to get
 *  the same effect less precisely. */
function resolveStart(el: HTMLElement): StartViewTransition | null {
  const scoped = (el as unknown as { startViewTransition?: StartViewTransition }).startViewTransition;
  if (typeof scoped === "function") return scoped.bind(el) as StartViewTransition;
  const doc = (document as unknown as { startViewTransition?: StartViewTransition }).startViewTransition;
  if (typeof doc === "function") return doc.bind(document) as StartViewTransition;
  return null;
}

/** Wrap session-list mutations in a view transition scoped to `scope`.
 *  `mutate` always runs exactly once, synchronously in every bail-out case. */
export function useSessionListTransition(scope: Ref<HTMLElement | null>) {
  let inFlight = false;
  let primed = false;

  function commit(kind: TransitionKind | null, mutate: () => void): void {
    const el = scope.value;
    const first = !primed;
    primed = true;
    if (kind === null || !el || first || inFlight || document.hidden || prefersReducedMotion()) {
      mutate();
      return;
    }
    const start = resolveStart(el);
    if (!start) {
      mutate();
      return;
    }
    inFlight = true;
    el.setAttribute("data-vt", kind);
    // Mirrored on :root because the document-level fallback hosts the
    // ::view-transition pseudo tree there, not on the scope element.
    document.documentElement.setAttribute("data-vt", kind);
    const transition = start(async () => {
      mutate();
      await nextTick();
    });
    // A skipped/aborted animation still ran the update callback — state is
    // correct, so swallow it rather than surfacing an error.
    transition.ready.catch(() => {});
    transition.finished.catch(() => {}).then(() => {
      inFlight = false;
      el.removeAttribute("data-vt");
      document.documentElement.removeAttribute("data-vt");
    });
  }

  return { commit };
}
