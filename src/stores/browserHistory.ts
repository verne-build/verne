import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  faviconUrl: string;
  visitedAt: number;
}

const STORAGE_KEY = "verne.browserHistory";
const MAX_HISTORY = 100;
const MAX_MATCHES = 6;

function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase().replace(/\/$/, "");
}

function faviconForUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `https://icons.duckduckgo.com/ip3/${host}.ico`;
  } catch {
    return "";
  }
}

function hydrate(): BrowserHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is BrowserHistoryEntry =>
        typeof entry?.url === "string" &&
        typeof entry?.title === "string" &&
        typeof entry?.visitedAt === "number",
      )
      .map((entry) => ({
        ...entry,
        faviconUrl: typeof entry.faviconUrl === "string" && entry.faviconUrl
          ? entry.faviconUrl
          : faviconForUrl(entry.url),
      }))
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

export const useBrowserHistoryStore = defineStore("browserHistory", () => {
  const entries = ref<BrowserHistoryEntry[]>(hydrate());

  const recent = computed(() => entries.value);

  watch(
    entries,
    (value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value.slice(0, MAX_HISTORY)));
      } catch {
        /* ignore persistence failures */
      }
    },
    { deep: true },
  );

  function add(entry: { url: string; title?: string; faviconUrl?: string }) {
    const url = entry.url.trim();
    if (!url || url.startsWith("about:") || url.startsWith("verne-")) return;

    const key = normalizeForCompare(url);
    const next: BrowserHistoryEntry = {
      url,
      title: entry.title?.trim() || url,
      faviconUrl: entry.faviconUrl || faviconForUrl(url),
      visitedAt: Date.now(),
    };
    entries.value = [
      next,
      ...entries.value.filter((item) => normalizeForCompare(item.url) !== key),
    ].slice(0, MAX_HISTORY);
  }

  function matches(query: string): BrowserHistoryEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return entries.value
      .filter((entry) =>
        entry.url.toLowerCase().includes(q) ||
        entry.title.toLowerCase().includes(q),
      )
      .slice(0, MAX_MATCHES);
  }

  return { entries, recent, add, matches };
});
