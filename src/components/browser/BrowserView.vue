<script setup lang="ts">
// Productized browser pane bound to a specific tab. Renders an Electron DOM
// <webview> laid out by CSS. Navigation/back/forward/reload route through
// Electron's WebContents id; URL/title tracking comes from webview events.
//
// The <webview> is a real DOM element, so the compositor handles bounds and
// z-index natively: overlays (command palette, context menus, dropdowns,
// address-bar suggestions) paint on top without hiding it. No occlusion dance -
// that was leftover from the Tauri WKWebView, which always painted on top.
import { ref, computed, onBeforeUnmount, onMounted, nextTick, watch } from "vue";
import { ArrowLeft, ArrowRight, Code, Globe, PanelLeft, RotateCw, Search, Star, MoreHorizontal, X } from "@lucide/vue";
import { toast } from "vue-sonner";
import { invoke } from "@/platform";
import { normalizeBrowserUrl, labelForUrl, isSearchQuery, browserLoadError } from "@/lib/browserTabs";
import type { BrowserLoadError } from "@/lib/browserTabs";
import { updateBrowserTab } from "@/composables/useFilePanelTabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { useBrowserHistoryStore } from "@/stores/browserHistory";
import type { BrowserHistoryEntry } from "@/stores/browserHistory";
import { useBrowserDataStore } from "@/stores/browserData";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import BrowserSidebar from "@/components/browser/BrowserSidebar.vue";

const props = defineProps<{ tabId: string; url: string; workspaceDir: string; directoryId?: string; active?: boolean; newTabMode?: boolean }>();

// In new-tab mode this pane is the synthetic "new tab page": the webview stays
// blank and committing the address bar spawns a real browser tab instead of
// navigating in place (parent handles the emit).
const emit = defineEmits<{ "navigate-new-tab": [url: string]; "open-new-tab": [url: string] }>();

type Suggestion =
  | { type: "navigate"; label: string; value: string; dest: string }
  | { type: "search"; label: string; value: string }
  | { type: "history"; label: string; value: string; entry: BrowserHistoryEntry };

// Minimal structural type for the Electron <webview> element we touch.
type WebviewEl = HTMLElement & {
  getWebContentsId(): number;
  getURL(): string;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  addEventListener(t: string, l: (e: unknown) => void): void;
  removeEventListener(t: string, l: (e: unknown) => void): void;
};

const webviewRef = ref<WebviewEl | null>(null);
const addressInput = ref<{ $el: HTMLInputElement } | null>(null);
const urlInput = ref("");
// Empty-state error for a failed page load (did-fail-load). Null = no error.
const loadError = ref<BrowserLoadError | null>(null);
const sel = ref(-1);
const focused = ref(false);
const addressEdited = ref(false);
const devtoolsOpen = ref(false);
const loading = ref(false);
const pageLoading = ref(false);
const progress = ref(0);
const progressFading = ref(false);
const history = useBrowserHistoryStore();
const browserData = useBrowserDataStore();
const sidebarOpen = ref(false);
// Whether back/forward are actually possible, queried from the guest
// WebContents' navigation history; disables the toolbar arrows when there's
// nowhere to go. The <webview> element doesn't expose navigationHistory, so we
// ask main (same API the native back/forward handlers use).
const canBack = ref(false);
const canForward = ref(false);

async function updateNavState() {
  const id = currentWebContentsId();
  if (id === null) { canBack.value = false; canForward.value = false; return; }
  try {
    const r = await invoke<{ back: boolean; forward: boolean }>("native_browser_can_go", { id });
    canBack.value = r.back;
    canForward.value = r.forward;
  } catch { /* webContents gone */ }
}

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value;
  if (sidebarOpen.value && props.directoryId) {
    browserData.load(props.directoryId).catch(() => {});
  }
}

function onSidebarNavigate(url: string) {
  sidebarOpen.value = false;
  go(url);
}

function removeFavoriteFromPanel(url: string) {
  if (props.directoryId) browserData.removeFavorite(props.directoryId, url).catch(() => {});
}

function openInNewTabFromPanel(url: string) {
  sidebarOpen.value = false;
  emit("open-new-tab", url);
}

function renameFavoriteFromPanel(url: string, title: string) {
  if (props.directoryId) browserData.renameFavorite(props.directoryId, url, title).catch(() => {});
}

function removeHistoryFromPanel(url: string) {
  if (props.directoryId) browserData.removeHistoryItem(props.directoryId, url).catch(() => {});
}

watch(() => props.directoryId, (id) => { if (id) browserData.load(id).catch(() => {}); }, { immediate: true });

// WebContents id of the guest, captured on dom-ready; null until ready.
let wcId: number | null = null;
let boundWebview: WebviewEl | null = null;
let currentTitle = "";
let progressRaf: ReturnType<typeof requestAnimationFrame> | null = null;
let progressDoneTimer: ReturnType<typeof setTimeout> | null = null;
let progressTarget = 0;
const initialUrl = props.url || "about:blank";

// Live page URL (incl. about:blank), tracked from navigation events. Drives the
// fresh-tab empty state below; urlInput can't, as it mirrors the address-bar edit.
const currentUrl = ref(initialUrl);
const isBlank = computed(() => !currentUrl.value || currentUrl.value.startsWith("about:blank"));

// ---- dimmed url parts ----
const urlParts = computed(() => {
  const raw = urlInput.value;
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const pre = u.protocol + "//";
    const host = u.hostname + (u.port ? `:${u.port}` : "");
    const post = u.pathname + u.search + u.hash;
    return { pre, host, post: post === "/" ? "" : post };
  } catch {
    return { pre: "", host: raw, post: "" };
  }
});

// ---- suggestions ----
const suggestions = computed(() => {
  const q = urlInput.value.trim();
  if (!focused.value || !addressEdited.value || !q) return [] as Suggestion[];
  // First row mirrors what Enter will do: navigate to a site, or search Google.
  const primary: Suggestion = isSearchQuery(q)
    ? { type: "search", label: `Search Google for "${q}"`, value: q }
    : { type: "navigate", label: q, value: q, dest: normalizeBrowserUrl(q) };
  const out: Suggestion[] = [primary];
  for (const entry of history.matches(q)) {
    out.push({
      type: "history",
      label: entry.title || labelForUrl(entry.url),
      value: entry.url,
      entry,
    });
  }
  return out;
});

function onAddressFocus(e: FocusEvent) {
  focused.value = true;
  addressEdited.value = false;
  // Select the whole URL on focus so clicking a populated bar highlights it
  // (type to replace). Defer past the click's mouseup, which would clear it.
  const el = e.target as HTMLInputElement;
  if (el.value) requestAnimationFrame(() => el.select());
}

function onAddressBlur() {
  focused.value = false;
  setTimeout(() => {
    sel.value = -1;
    addressEdited.value = false;
  }, 150);
}

function onAddressInput() {
  addressEdited.value = true;
  sel.value = -1;
}

// ---- navigation ----
function currentWebContentsId(): number | null {
  if (wcId !== null) return wcId;
  try {
    const id = webviewRef.value?.getWebContentsId();
    if (typeof id === "number") wcId = id;
  } catch {
    return null;
  }
  return wcId;
}

async function go(v: string) {
  const url = normalizeBrowserUrl(v);
  if (!url) return;
  sel.value = -1;
  addressEdited.value = false;
  // New-tab page: hand the URL to the parent to spawn a real tab, then reset to
  // blank so the pinned new-tab page is fresh next time.
  if (props.newTabMode) {
    emit("navigate-new-tab", url);
    urlInput.value = "";
    focused.value = false;
    return;
  }
  const id = currentWebContentsId();
  if (id === null) return;
  // Kick a fresh progress cycle now so loading a new page mid-load restarts the
  // bar cleanly instead of parking the previous trickle near 90%.
  onStartLoading();
  try {
    urlInput.value = await invoke<string>("native_browser_navigate", { id, url });
  } catch (e) {
    toast.error(String(e));
  }
}

function onAddressKey(e: KeyboardEvent) {
  const items = suggestions.value;
  if (e.key === "Enter") {
    go(sel.value >= 0 && items[sel.value] ? items[sel.value].value : urlInput.value);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    sel.value = Math.min(sel.value + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    sel.value = Math.max(sel.value - 1, 0);
  } else if (e.key === "Escape") {
    (e.target as HTMLInputElement).blur();
  }
}

async function navCmd(cmd: "native_browser_back" | "native_browser_forward" | "native_browser_reload" | "native_browser_stop") {
  const id = currentWebContentsId();
  if (id === null) return;
  await invoke(cmd, { id }).catch((e) => toast.error(String(e)));
}

// ---- favorites + overflow menu ----
const isFavorited = computed(() => browserData.isFavorite(currentUrl.value));

function toggleFavorite() {
  const url = currentUrl.value;
  if (!url || url.startsWith("about:") || url.startsWith("verne-")) return;
  if (!props.directoryId) return;
  const title = currentTitle.trim() || labelForUrl(url);
  let faviconUrl: string | null = null;
  try { faviconUrl = `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`; } catch { /* ignore */ }
  if (isFavorited.value) browserData.removeFavorite(props.directoryId, url).catch((e) => toast.error(String(e)));
  else browserData.addFavorite(props.directoryId, url, title, faviconUrl).catch((e) => toast.error(String(e)));
}

function copyUrl() {
  if (currentUrl.value) navigator.clipboard.writeText(currentUrl.value).catch(() => {});
}

async function hardReload() {
  const id = currentWebContentsId();
  if (id === null) return;
  await invoke("native_browser_reload_hard", { id }).catch((e) => toast.error(String(e)));
}

async function clearBrowsingHistory() {
  if (!props.directoryId) return;
  await browserData.clearHistory(props.directoryId).catch((e) => toast.error(String(e)));
}

async function clearCookies() {
  await invoke("native_browser_clear_cookies", {}).catch((e) => toast.error(String(e)));
}

async function clearCache() {
  await invoke("native_browser_clear_cache", {}).catch((e) => toast.error(String(e)));
}

// DevTools opens detached via the <webview>'s own openDevTools(), which always
// opens in a separate window for a guest. Embedding into a second webview was
// abandoned: Electron 42 broke setDevToolsWebContents into a <webview> host (the
// frontend boots but the target agent never attaches - Elements stay empty).
// devtools-opened/closed (bound in bindWebview) keep devtoolsOpen synced so the
// toolbar reflects the window being closed directly.
function onDevtoolsOpened() {
  devtoolsOpen.value = true;
}

function onDevtoolsClosed() {
  devtoolsOpen.value = false;
}

function openDevtools() {
  const wv = webviewRef.value;
  if (!wv) {
    toast.error("Webview is not ready yet.");
    return;
  }
  try {
    if (wv.isDevToolsOpened()) wv.closeDevTools();
    else wv.openDevTools();
  } catch (e) {
    toast.error(String(e));
  }
}

// ---- URL/title tracking ----
function reportUrl(url?: string) {
  const u = url || webviewRef.value?.getURL() || "";
  currentUrl.value = u;
  // Ignore empty, about:* and verne-* scheme URLs - transient redirect hops or
  // internal sentinel pings, not real destinations.
  const isReal = !u.startsWith("about:") && !u.startsWith("verne-");
  if (!isReal) return;
  // Track the page URL (incl. redirects) unless the user is actively editing the
  // address bar. go() clears addressEdited on commit, so after Enter/click the
  // bar follows the live navigation - e.g. bbc.com -> www.bbc.co.uk.
  if (!addressEdited.value) urlInput.value = u;
  let faviconUrl: string | undefined;
  try {
    const host = new URL(u).hostname;
    faviconUrl = `https://icons.duckduckgo.com/ip3/${host}.ico`;
  } catch { /* ignore invalid urls */ }
  const title = currentTitle.trim();
  const label = title || labelForUrl(u);
  updateBrowserTab(props.tabId, {
    ...(label ? { label } : {}),
    ...(faviconUrl ? { faviconUrl } : {}),
    browserUrl: u,
  });
  history.add({ url: u, title: label, faviconUrl });
  if (props.directoryId && !props.newTabMode) {
    browserData.recordVisit(props.directoryId, u, label, faviconUrl ?? null).catch(() => {});
  }
}

function onDomReady() {
  if (!webviewRef.value) return;
  try {
    wcId = webviewRef.value.getWebContentsId();
  } catch {
    wcId = null;
  }
  updateNavState();
  // Register this tab with main so the CDP browser-control server can attach a
  // debugger and drive it for agent automation. Idempotent on refire. The blank
  // new-tab page is never a real navigation target, so skip it.
  if (wcId !== null && !props.newTabMode) {
    invoke("native_browser_register", { tabId: props.tabId, wcId, workspaceDir: props.workspaceDir })
      .then(() => { if (props.active) reportActive(); })
      .catch((e) => { toast.error(String(e)); });
  }
}

// Tell main which browser tab the user is viewing, so browser_list can flag the
// active tab for agents. Fires on activation and after (re)registration.
function reportActive() {
  if (props.newTabMode) return;
  invoke("native_browser_set_active", { tabId: props.tabId, workspaceDir: props.workspaceDir }).catch(() => {});
}
watch(() => props.active, (a) => { if (a) reportActive(); });

function onKeydown(e: KeyboardEvent) { if (e.key === "Escape" && sidebarOpen.value) sidebarOpen.value = false; }

// New-tab page is mounted fresh each time it's shown (v-if), so focus the
// address bar on mount so the user can type a URL/query immediately.
onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  if (!props.newTabMode) return;
  await nextTick();
  addressInput.value?.$el?.focus();
});

// ---- load progress ----
// A <webview> exposes no real load percentage (only did-start/stop-loading), so
// use real milestones where Electron exposes them, with an optimistic
// Chrome/NProgress-style trickle between events.
function stopProgressAnimation() {
  if (progressRaf !== null) {
    cancelAnimationFrame(progressRaf);
    progressRaf = null;
  }
}

function animateProgress() {
  if (pageLoading.value && progressTarget < 0.9) {
    progressTarget += (0.9 - progressTarget) * 0.006;
  }

  const delta = progressTarget - progress.value;
  if (delta <= 0.001) {
    progress.value = progressTarget;
  } else {
    progress.value += delta * 0.11;
  }

  if (loading.value && progress.value < 0.995) {
    progressRaf = requestAnimationFrame(animateProgress);
  } else {
    progressRaf = null;
  }
}

function setProgressTarget(target: number) {
  if (!loading.value) return;
  progressTarget = Math.max(progressTarget, Math.min(target, pageLoading.value ? 0.96 : 1));
  if (progressRaf === null) progressRaf = requestAnimationFrame(animateProgress);
}

function onStartLoading() {
  // Reloading / navigating dismisses any prior load-failure screen.
  loadError.value = null;
  // The new-tab page never navigates in place; its blank about:blank load
  // shouldn't flash the progress bar.
  if (props.newTabMode) return;
  if (progressDoneTimer) { clearTimeout(progressDoneTimer); progressDoneTimer = null; }
  stopProgressAnimation();
  progressFading.value = false;
  pageLoading.value = true;
  loading.value = true;
  progress.value = progress.value >= 0.98 ? 0.04 : Math.max(progress.value, 0.04);
  progressTarget = Math.max(progress.value, 0.18);
  progressRaf = requestAnimationFrame(animateProgress);
}

function onStartNavigation() {
  setProgressTarget(0.28);
}

function onDomContentLoaded() {
  setProgressTarget(0.62);
}

function onFrameFinished(e: unknown) {
  const isMainFrame = (e as { isMainFrame?: boolean }).isMainFrame;
  setProgressTarget(isMainFrame ? 0.82 : 0.7);
}

function onFinishLoad() {
  setProgressTarget(0.94);
}

function onStopLoading() {
  updateNavState();
  pageLoading.value = false;
  if (!loading.value) return;
  stopProgressAnimation();
  progressTarget = 1;
  progress.value = 1;
  progressFading.value = true;
  if (progressDoneTimer) clearTimeout(progressDoneTimer);
  progressDoneTimer = setTimeout(() => {
    loading.value = false;
    progress.value = 0;
    progressTarget = 0;
    progressFading.value = false;
    progressDoneTimer = null;
  }, 300);
}

// about:blank = fresh new tab; show empty address bar so user can type.
urlInput.value = (props.url === "about:blank" || !props.url) ? "" : props.url;

onBeforeUnmount(() => {
  const wv = boundWebview;
  if (wv) {
    wv.removeEventListener("dom-ready", onDomReady);
    wv.removeEventListener("did-navigate", onDidNavigate);
    wv.removeEventListener("did-navigate-in-page", onDidNavigate);
    wv.removeEventListener("page-title-updated", onPageTitleUpdated);
    wv.removeEventListener("devtools-opened", onDevtoolsOpened);
    wv.removeEventListener("devtools-closed", onDevtoolsClosed);
    wv.removeEventListener("did-start-loading", onStartLoading);
    wv.removeEventListener("did-start-navigation", onStartNavigation);
    wv.removeEventListener("did-fail-load", onDidFailLoad);
    wv.removeEventListener("dom-ready", onDomContentLoaded);
    wv.removeEventListener("did-frame-finish-load", onFrameFinished);
    wv.removeEventListener("did-finish-load", onFinishLoad);
    wv.removeEventListener("did-stop-loading", onStopLoading);
    try {
      if (wv.isDevToolsOpened()) wv.closeDevTools();
    } catch { /* webview already torn down */ }
  }
  stopProgressAnimation();
  if (progressDoneTimer) clearTimeout(progressDoneTimer);
  // Detach the CDP session for this tab (main drops the registry entry). The
  // new-tab page was never registered, so nothing to unregister.
  if (!props.newTabMode) invoke("native_browser_unregister", { tabId: props.tabId }).catch(() => {});
  window.removeEventListener("keydown", onKeydown);
});

function onDidNavigate(e: unknown) {
  reportUrl((e as { url?: string }).url);
  updateNavState();
}

function onPageTitleUpdated(e: unknown) {
  currentTitle = (e as { title?: string }).title || "";
  reportUrl();
}

// A failed main-frame navigation (e.g. ERR_CONNECTION_REFUSED) -> empty-state
// error overlay. Sub-frame and user-aborted failures are filtered in the helper.
function onDidFailLoad(e: unknown) {
  const ev = e as { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
  loadError.value = browserLoadError(
    ev.errorCode ?? 0,
    ev.errorDescription ?? "",
    ev.validatedURL ?? currentUrl.value,
    ev.isMainFrame ?? true,
  );
}

function bindWebview(el: WebviewEl | null) {
  webviewRef.value = el;
  if (!el || boundWebview === el) return;
  boundWebview = el;
  el.addEventListener("dom-ready", onDomReady);
  el.addEventListener("did-navigate", onDidNavigate);
  el.addEventListener("did-navigate-in-page", onDidNavigate);
  el.addEventListener("page-title-updated", onPageTitleUpdated);
  el.addEventListener("devtools-opened", onDevtoolsOpened);
  el.addEventListener("devtools-closed", onDevtoolsClosed);
  el.addEventListener("did-start-loading", onStartLoading);
  el.addEventListener("did-start-navigation", onStartNavigation);
  el.addEventListener("did-fail-load", onDidFailLoad);
  el.addEventListener("dom-ready", onDomContentLoaded);
  el.addEventListener("did-frame-finish-load", onFrameFinished);
  el.addEventListener("did-finish-load", onFinishLoad);
  el.addEventListener("did-stop-loading", onStopLoading);
}
</script>

<template>
  <div class="relative flex h-full w-full flex-col bg-background text-foreground">
    <!-- Load progress: thin bar pinned to the very top of the pane (between the
         file-tab bar and the address bar). Width is a simulated trickle (see
         onStartLoading). -->
    <div v-if="loading" class="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden">
      <div
        class="h-full bg-chart-1 transition-[width,opacity] duration-200 ease-out"
        :style="{ width: `${Math.round(progress * 100)}%` }"
        :class="progressFading ? 'opacity-0' : 'opacity-100'"
      ></div>
    </div>
    <!-- Address bar - bg matches sidebar -->
    <div class="relative flex h-8 items-center gap-1 border-b border-border bg-sidebar px-2">
      <Button
        variant="ghost" size="icon-xs"
        :class="sidebarOpen ? 'text-primary' : 'text-muted-foreground'"
        title="Favorites & History"
        @click="toggleSidebar"
      >
        <PanelLeft class="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-xs" class="text-muted-foreground" title="Back" :disabled="!canBack" @click="navCmd('native_browser_back')">
        <ArrowLeft class="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-xs" class="text-muted-foreground" title="Forward" :disabled="!canForward" @click="navCmd('native_browser_forward')">
        <ArrowRight class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        :title="pageLoading ? 'Stop' : 'Reload'"
        :disabled="isBlank && !pageLoading"
        @click="navCmd(pageLoading ? 'native_browser_stop' : 'native_browser_reload')"
      >
        <span class="relative grid size-3.5 place-items-center">
          <RotateCw
            class="browser-nav-swap-icon absolute size-3.5"
            :class="pageLoading ? 'scale-80 rotate-45 opacity-0' : 'scale-100 rotate-0 opacity-100'"
          />
          <X
            class="browser-nav-swap-icon absolute size-3.5"
            :class="pageLoading ? 'scale-100 rotate-0 opacity-100' : 'scale-80 -rotate-45 opacity-0'"
          />
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        :class="isFavorited ? 'text-primary' : 'text-muted-foreground'"
        :title="isFavorited ? 'Remove from Favorites' : 'Add to Favorites'"
        :disabled="isBlank"
        @click="toggleFavorite"
      >
        <Star class="size-3.5" :class="isFavorited ? 'fill-current' : ''" />
      </Button>
      <div class="relative mx-1 flex-1">
        <Input
          ref="addressInput"
          v-model="urlInput"
          class="block h-6 border-transparent bg-transparent px-2 text-xs md:text-xs shadow-none hover:bg-input/30 focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0"
          :class="!focused && urlInput ? 'text-transparent caret-transparent' : ''"
          placeholder="Search or enter address"
          @focus="onAddressFocus"
          @blur="onAddressBlur"
          @input="onAddressInput"
          @keydown="onAddressKey"
        />
        <!-- Dimmed URL overlay: visible when blurred and input has content -->
        <div
          v-if="!focused && urlParts && urlInput"
          class="pointer-events-none absolute inset-y-0 left-0 right-0 flex items-center overflow-hidden rounded border border-transparent px-2 text-xs"
          aria-hidden="true"
        >
          <span class="opacity-50">{{ urlParts.pre }}</span>
          <span class="text-foreground">{{ urlParts.host }}</span>
          <span class="opacity-50 truncate">{{ urlParts.post }}</span>
        </div>
        <!-- Mirrors the Command/CommandList/CommandItem styling, but as plain
             elements instead of reka-ui's ListboxRoot: a ListboxRoot focuses its
             first item on mount (unless a ListboxFilter/CommandInput holds focus),
             stealing focus from the address Input and truncating typed URLs.
             Selection/keyboard is driven manually by sel/onAddressKey. -->
        <div
          v-if="focused && suggestions.length"
          class="absolute left-0 right-0 top-full z-50 mt-1 flex flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-xl"
        >
          <div class="max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto p-1" role="presentation">
            <div
              v-for="(s, i) in suggestions"
              :key="`${s.type}:${s.value}`"
              role="option"
              :aria-selected="i === sel"
              class="hover:bg-secondary/50 hover:text-secondary-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
              :class="i === sel ? 'bg-secondary/50 text-secondary-foreground' : ''"
              @mousedown.prevent
              @click="go(s.value)"
            >
              <Search v-if="s.type === 'search'" class="size-4 shrink-0 opacity-70" />
              <Globe v-else-if="s.type === 'navigate'" class="size-4 shrink-0 opacity-70" />
              <img
                v-else
                :src="s.entry.faviconUrl"
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate">{{ s.label }}</span>
              <span v-if="s.type === 'history'" class="min-w-0 max-w-[45%] truncate text-xs opacity-60">{{ s.value }}</span>
              <span v-else-if="s.type === 'navigate'" class="min-w-0 max-w-[45%] truncate text-xs opacity-60">{{ s.dest }}</span>
            </div>
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="devtoolsOpen ? 'Close DevTools' : 'Open DevTools'"
        :class="devtoolsOpen ? 'text-primary' : 'text-muted-foreground'"
        @click="openDevtools"
      >
        <Code class="size-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-xs" class="text-muted-foreground" title="More">
            <MoreHorizontal class="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-44">
          <DropdownMenuItem @select="hardReload">Hard Reload</DropdownMenuItem>
          <DropdownMenuItem @select="copyUrl">Copy URL</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="clearBrowsingHistory">Clear Browsing History</DropdownMenuItem>
          <DropdownMenuItem @select="clearCookies">Clear Cookies</DropdownMenuItem>
          <DropdownMenuItem @select="clearCache">Clear Cache</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="relative min-h-0 flex-1 overflow-hidden bg-white">
      <!-- <webview> is registered by Electron (webviewTag). isCustomElement in
           electron.vite.config.ts stops Vue treating it as a component.
           backgroundColor white so transparent-bodied sites composite onto
           white, not the dark Verne window. -->
      <webview
        :ref="(el: unknown) => bindWebview(el as WebviewEl | null)"
        :src="initialUrl"
        partition="persist:verne-browser"
        webpreferences="contextIsolation=yes,sandbox=yes,devTools=yes"
        backgroundColor="#ffffff"
        class="flex h-full w-full"
      ></webview>
      <!-- Fresh-tab empty state: overlays the blank webview until the user
           navigates somewhere. pointer-events-none lets clicks fall through. -->
      <div v-if="isBlank" class="pointer-events-none absolute inset-0 flex items-center justify-center bg-sidebar">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Globe /></EmptyMedia>
            <EmptyTitle>Browser</EmptyTitle>
            <EmptyDescription>Search or enter an address above to get started.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
      <!-- Load-failure empty state: covers the webview when a navigation fails
           (e.g. connection refused). Cleared on the next load (onStartLoading).
           Not pointer-events-none — it fully replaces the dead page. bg-sidebar
           (not white) so the Empty component's themed colors read correctly;
           only the webview itself is white. -->
      <div v-if="loadError" class="absolute inset-0 flex items-center justify-center bg-sidebar">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Globe /></EmptyMedia>
            <EmptyTitle>{{ loadError.title }}</EmptyTitle>
            <EmptyDescription>{{ loadError.description }}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
    <Transition name="browser-sidebar">
      <BrowserSidebar
        v-if="sidebarOpen"
        :favorites="browserData.favorites"
        :history="browserData.history"
        @navigate="onSidebarNavigate"
        @open-new-tab="openInNewTabFromPanel"
        @remove-favorite="removeFavoriteFromPanel"
        @rename-favorite="renameFavoriteFromPanel"
        @remove-history="removeHistoryFromPanel"
        @close="sidebarOpen = false"
      />
    </Transition>
  </div>
</template>

<style scoped>
.browser-nav-swap-icon {
  transform-origin: 50% 50%;
  transition:
    opacity 140ms ease-out,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
  backface-visibility: hidden;
  will-change: opacity, transform;
}
</style>

<style scoped>
.browser-sidebar-enter-active, .browser-sidebar-leave-active { transition: opacity 0.15s ease; }
.browser-sidebar-enter-from, .browser-sidebar-leave-to { opacity: 0; }
</style>
