import { onScopeDispose, type Ref } from "vue";
import type { ListChangeKind } from "@/lib/sessionsView";

export type AnimationKind = NonNullable<ListChangeKind> | "toggle";

/** Must outlive the longest transition declared in style.css. */
export const SESSION_ANIM_MS = 260;

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

  function disarm(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    scope.value?.removeAttribute("data-anim");
  }
  onScopeDispose(disarm);

  function commit(kind: AnimationKind | null, mutate: () => void): void {
    const el = scope.value;
    if (kind === null || !el || document.hidden || prefersReducedMotion()) {
      mutate();
      return;
    }
    // Arm before mutating: the transition has to be live at the moment the
    // virtualizer writes the new transforms, or the rows jump instead.
    el.setAttribute("data-anim", kind);
    if (timer) clearTimeout(timer);
    mutate();
    timer = setTimeout(() => {
      timer = undefined;
      el.removeAttribute("data-anim");
    }, SESSION_ANIM_MS);
  }

  return { commit };
}
