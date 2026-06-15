import { onMounted, onBeforeUnmount } from "vue";
import { invoke } from "@/platform";

// Window dragging is handled entirely in JS — we deliberately do NOT use native
// `-webkit-app-region: drag` (see style.css). Native is unreliable here: at an
// unclipped root it captures clicks on child buttons (native `no-drag` is not
// honored), and inside reka-ui's overflow-clipped panels it's dropped anyway. So
// every `.drag-region` relies on this one delegated listener: mousedown always
// reaches the DOM (nothing is natively swallowed) and we drag via IPC (main
// follows the cursor), excluding interactive controls below.
const NO_DRAG =
  'button, a, input, select, textarea, [role="button"], [role="tab"], [contenteditable="true"], [data-no-drag]';

export function useWindowDrag() {
  const isDragHandle = (e: MouseEvent): boolean => {
    const t = e.target as Element | null;
    return !!t && !!t.closest(".drag-region") && !t.closest(NO_DRAG);
  };

  const endDrag = () => {
    void invoke("window_drag_end");
    window.removeEventListener("mouseup", endDrag);
    window.removeEventListener("blur", endDrag);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !isDragHandle(e)) return;
    e.preventDefault();
    void invoke("window_drag_start");
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("blur", endDrag);
  };

  const onDblClick = (e: MouseEvent) => {
    if (!isDragHandle(e)) return;
    void invoke("toggle_maximize");
  };

  onMounted(() => {
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("dblclick", onDblClick);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("dblclick", onDblClick);
    endDrag();
  });
}
