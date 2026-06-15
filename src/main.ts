import "./style.css";
import "vue-sonner/style.css";

// Suppress the WKWebView native context menu (Reload / Inspect / Autofill),
// which the app never uses. Inside a shadcn ContextMenu trigger, reka-ui itself
// calls preventDefault (after `await nextTick()`) which suppresses the native
// menu AND opens its own — so skip those; a pre-emptive synchronous
// preventDefault there sets defaultPrevented before reka's check, making reka
// bail. NEVER dispatch a synthetic `contextmenu` to "help" reka open: a
// JS-dispatched contextmenu re-raises WebKit's native menu and reka's deferred
// preventDefault can't cancel it in time.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as Element | null;
  if (target?.closest?.('[data-slot="context-menu-trigger"]')) return;
  e.preventDefault();
});
import App from "./App.vue";
import { createApp } from "vue";
import { createPinia } from "pinia";
import { initRpc } from "./composables/useRpc";
import { useWorkspaceStore } from "./stores/workspace";
import { useSettings, loadCachedSettings } from "./composables/useSettings";
import { useTheme, applyCachedThemeSync } from "./composables/useTheme";
import { listen } from "@/platform";
import { preloadConfiguredTerminalFont, reconnectAllTerminals } from "./composables/useTerminal";

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
app.directive("focus", {
  mounted: (el: HTMLElement) => {
    // Defer to the next frame: when a rename is triggered from a closing
    // overlay (e.g. the context menu), the overlay's focus teardown runs first
    // and would otherwise steal focus before our select() takes effect.
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      el.focus();
      // Highlight the name ready to edit. For files, select the basename only
      // (exclude the extension); dotfiles / dirs / no-extension select all.
      if (el instanceof HTMLInputElement) {
        const dot = el.value.lastIndexOf(".");
        if (dot > 0) el.setSelectionRange(0, dot);
        else el.select();
      }
    });
  },
});

const store = useWorkspaceStore();

// Dev-only startup timing. Absolute time since navigation start.
const mark = import.meta.env.DEV
  ? (label: string) => console.log(`[startup] +${performance.now().toFixed(0)}ms ${label}`)
  : (_label: string) => {};
const reportPaintMetrics = import.meta.env.DEV
  ? () => {
      for (const entry of performance.getEntriesByType("paint")) {
        console.log(`[startup] +${entry.startTime.toFixed(0)}ms ${entry.name} (browser metric)`);
      }
    }
  : () => {};
mark("script first exec");

async function bootstrap() {
  mark("bootstrap start");

  // 1. Sync first-paint state from localStorage cache
  applyCachedThemeSync();
  loadCachedSettings();
  mark("cache applied");

  // 2. Mount the app — first paint happens here.
  app.mount("#app");
  mark("app.mount returned");
  requestAnimationFrame(() => {
    mark("RAF #1 after mount");
    requestAnimationFrame(() => {
      mark("RAF #2 after mount");
      reportPaintMetrics();
    });
  });

  // 3. Fire-and-forget post-mount hydration. Order independent.
  preloadConfiguredTerminalFont()
    .then(() => mark("font preload done"))
    .catch((e) => console.error("Font preload failed:", e));

  initRpc()
    .then(() => mark("initRpc done"))
    .catch((e) => console.error("initRpc failed:", e));

  Promise.all([store.fetchDirectories(), store.loadAllTabs()])
    .then(() => mark("dirs+tabs done"))
    .catch((e) => console.error("Initial directory/tabs fetch failed:", e));

  useSettings().listenForChanges();
  useSettings()
    .load()
    .then(() => mark("settings load done"))
    .catch((e) => console.error("Settings load failed:", e));

  useTheme()
    .init()
    .then(() => mark("theme init done"))
    .catch((e) => console.error("Theme init failed:", e));

  // Reconnect terminals after macOS sleep/wake.
  listen("system-resumed", () => {
    reconnectAllTerminals();
  });
}

bootstrap();

// Dev-only: a Vite HMR update reflows the DOM without necessarily changing the
// editor container's size, so Monaco's automaticLayout ResizeObserver never
// fires and the view can be left blank. Force a remeasure after each update.
if (import.meta.hot) {
  import.meta.hot.on("vite:afterUpdate", () => {
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("relayout-editors")),
    );
  });
}
