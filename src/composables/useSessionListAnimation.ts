import { onScopeDispose, type Ref } from "vue";
import type { ListChangeKind } from "@/lib/sessionsView";

export type AnimationKind = NonNullable<ListChangeKind> | "toggle";

/** Must outlive the longest transition declared in style.css. */
export const SESSION_ANIM_MS = 260;

/** Exits are quicker than the slide — the card is leaving, don't dwell on it. */
export const SESSION_LEAVE_MS = 180;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Arm a CSS transition window on the session list, then mutate.
 *
 *  Rows are absolutely positioned by the virtualizer via inline
 *  `transform: translateY(...)`, so once a transition on `transform` is armed,
 *  the virtualizer writing new offsets *is* the animation — rows slide to
 *  their new positions on their own. The window is gated by `data-anim`
 *  rather than left on permanently, because the virtualizer also rewrites
 *  those offsets while scrolling, and animating that would be wrong.
 *
 *  This replaces an earlier View Transitions implementation. That approach
 *  cannot work here: view transitions morph elements captured in both
 *  snapshots, but capture is clipped to the scroll container's visible region
 *  and a virtualized list frequently does not render the destination row at
 *  all — guaranteed when the Archived section is collapsed. Chromium
 *  generated every group animation with identical start and end geometry.
 */
export function useSessionListAnimation(scope: Ref<HTMLElement | null>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ghosts = new Set<HTMLElement>();

  function clearGhosts(): void {
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  }

  function disarm(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    scope.value?.removeAttribute("data-anim");
    clearGhosts();
  }
  onScopeDispose(disarm);

  /** A row that is about to unmount cannot animate itself, so leave a clone
   *  behind and collapse that while the real rows slide up underneath. Only
   *  rows on screen are cloned; off-screen ones are invisible anyway and
   *  cloning a long archived list would be pure waste. */
  function spawnLeaveGhosts(el: HTMLElement, surviving: ReadonlySet<string>): void {
    const rows = el.querySelectorAll<HTMLElement>("[data-session-row]");
    if (!rows.length || typeof rows[0].animate !== "function") return;
    const view = el.getBoundingClientRect();
    for (const row of rows) {
      const key = row.dataset.sessionRow ?? "";
      if (surviving.has(key)) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom < view.top || rect.top > view.bottom) continue;
      const ghost = row.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-index");
      ghost.removeAttribute("data-session-row");
      ghost.setAttribute("data-session-ghost", "");
      ghost.style.pointerEvents = "none";
      ghost.style.transformOrigin = "top";
      row.parentElement?.appendChild(ghost);
      ghosts.add(ghost);
      const base = row.style.transform;
      const animation = ghost.animate(
        [
          { opacity: 1, transform: `${base} scaleY(1)` },
          { opacity: 0, transform: `${base} scaleY(0.85)` },
        ],
        { duration: SESSION_LEAVE_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
      );
      animation.finished.catch(() => {}).then(() => {
        ghost.remove();
        ghosts.delete(ghost);
      });
    }
  }

  /** `surviving` is the set of item keys that will still be rendered after
   *  `mutate`. Anything rendered now and missing from it gets a leave ghost. */
  function commit(
    kind: AnimationKind | null,
    mutate: () => void,
    surviving?: ReadonlySet<string>,
  ): void {
    const el = scope.value;
    if (kind === null || !el || document.hidden || prefersReducedMotion()) {
      mutate();
      return;
    }
    // Arm before mutating: the transition has to be live at the moment the
    // virtualizer writes the new transforms, or the rows jump instead.
    el.setAttribute("data-anim", kind);
    if (timer) clearTimeout(timer);
    if (surviving) spawnLeaveGhosts(el, surviving);
    mutate();
    timer = setTimeout(() => {
      timer = undefined;
      el.removeAttribute("data-anim");
    }, SESSION_ANIM_MS);
  }

  return { commit };
}
