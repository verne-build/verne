import { defineStore } from "pinia";
import { ref } from "vue";
import { useRpc } from "@/composables/useRpc";
import type { BrowserFavorite, BrowserHistoryItem } from "@/types";

export const useBrowserDataStore = defineStore("browserData", () => {
  const favorites = ref<BrowserFavorite[]>([]);
  const history = ref<BrowserHistoryItem[]>([]);
  let latestLoad = 0;

  async function load(directoryId: string): Promise<void> {
    const token = ++latestLoad;
    const { request } = useRpc();
    const [favs, hist] = await Promise.all([
      request.browserFavoritesList({ directoryId }),
      request.browserHistoryList({ directoryId }),
    ]);
    if (token !== latestLoad) return; // a newer load started — discard this result
    favorites.value = favs;
    history.value = hist;
  }

  function isFavorite(url: string): boolean {
    return favorites.value.some(f => f.url === url);
  }

  async function addFavorite(
    directoryId: string,
    url: string,
    title: string,
    faviconUrl: string | null,
  ): Promise<void> {
    const { request } = useRpc();
    await request.browserFavoriteAdd({ directoryId, url, title, faviconUrl });
    // Optimistic: dedup by url then unshift
    favorites.value = [
      { url, title, faviconUrl, addedAt: Date.now() },
      ...favorites.value.filter(f => f.url !== url),
    ];
  }

  async function removeFavorite(directoryId: string, url: string): Promise<void> {
    const { request } = useRpc();
    await request.browserFavoriteRemove({ directoryId, url });
    favorites.value = favorites.value.filter(f => f.url !== url);
  }

  async function recordVisit(
    directoryId: string,
    url: string,
    title: string,
    faviconUrl: string | null,
  ): Promise<void> {
    const { request } = useRpc();
    await request.browserHistoryRecord({ directoryId, url, title, faviconUrl });
    // Update in-memory: remove existing same-url, unshift fresh
    const item: BrowserHistoryItem = { url, title, faviconUrl, visitedAt: Date.now() };
    history.value = [item, ...history.value.filter(h => h.url !== url)];
  }

  async function clearHistory(directoryId: string): Promise<void> {
    const { request } = useRpc();
    await request.browserHistoryClear({ directoryId });
    history.value = [];
  }

  async function renameFavorite(directoryId: string, url: string, title: string): Promise<void> {
    const { request } = useRpc();
    await request.browserFavoriteRename({ directoryId, url, title });
    favorites.value = favorites.value.map(f => (f.url === url ? { ...f, title } : f));
  }

  async function removeHistoryItem(directoryId: string, url: string): Promise<void> {
    const { request } = useRpc();
    await request.browserHistoryRemove({ directoryId, url });
    history.value = history.value.filter(h => h.url !== url);
  }

  return {
    favorites,
    history,
    load,
    isFavorite,
    addFavorite,
    removeFavorite,
    recordVisit,
    clearHistory,
    renameFavorite,
    removeHistoryItem,
  };
});
