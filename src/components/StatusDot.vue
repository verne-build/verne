<script lang="ts">
import { defineComponent, h } from "vue";
import { CENTER, INNER_R } from "./statusIndicator";

// Plain status dot for idle/unknown. A solid disc filling the ring's interior (the
// blocked center dot + the gap to the ring), so the indicators read as one set. Color
// via `currentColor` (set a text-* class on the element).
export default defineComponent({
  name: "StatusDot",
  setup() {
    return () =>
      h("svg", { viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" },
        h("circle", { cx: CENTER, cy: CENTER, r: INNER_R }));
  },
});
</script>
