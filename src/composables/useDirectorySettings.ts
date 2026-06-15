import { ref, watch, type Ref } from "vue";
import { useRpc } from "@/composables/useRpc";
import type { DirectorySettings } from "@/types";

export function useDirectorySettings(directoryId: Ref<string | null>) {
  const { request } = useRpc();
  const settings = ref<DirectorySettings>({});
  const loading = ref(false);

  async function load(id: string) {
    loading.value = true;
    try {
      settings.value = await request.getDirectorySettings({ directoryId: id });
    } catch (e) {
      console.error("[useDirectorySettings] load:", e);
      settings.value = {};
    } finally {
      loading.value = false;
    }
  }

  async function update(partial: Partial<DirectorySettings>) {
    const id = directoryId.value;
    if (!id) return;
    const previous = { ...settings.value };
    settings.value = { ...settings.value, ...partial };
    try {
      settings.value = await request.updateDirectorySettings({ directoryId: id, partial });
    } catch (e) {
      console.error("[useDirectorySettings] update:", e);
      settings.value = previous;
    }
  }

  watch(
    directoryId,
    (id) => {
      if (id) load(id);
      else settings.value = {};
    },
    { immediate: true },
  );

  return { settings, loading, update };
}
