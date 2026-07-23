import { onBeforeUnmount, onMounted, ref } from "vue";

// Tracks whether a scroll container is at its top / bottom edge so a panel can
// fade content in/out against fixed chrome. Recomputes on scroll, on resize
// (ResizeObserver), and whenever the consumer calls update() after content
// changes.
export function useScrollFades(direction: "vertical" | "horizontal" = "vertical") {
  const bodyEl = ref<HTMLElement | null>(null);
  const atStart = ref(true);
  const atEnd = ref(true);

  function update() {
    const el = bodyEl.value;
    if (!el) return;
    const offset = direction === "horizontal" ? el.scrollLeft : el.scrollTop;
    const viewport = direction === "horizontal" ? el.clientWidth : el.clientHeight;
    const extent = direction === "horizontal" ? el.scrollWidth : el.scrollHeight;
    atStart.value = offset <= 0;
    // -1 fudge for sub-pixel/zoom rounding
    atEnd.value = offset + viewport >= extent - 1;
  }

  let ro: ResizeObserver | null = null;
  onMounted(() => {
    update();
    if (bodyEl.value && "ResizeObserver" in window) {
      ro = new ResizeObserver(() => update());
      ro.observe(bodyEl.value);
    }
  });
  onBeforeUnmount(() => {
    ro?.disconnect();
    ro = null;
  });

  return { bodyEl, atStart, atEnd, update };
}
