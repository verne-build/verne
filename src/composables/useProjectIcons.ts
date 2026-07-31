import { ref } from "vue";
import { useRpc } from "@/composables/useRpc";
import { convertFileSrc } from "@/platform";

const icons = ref<Record<string, string>>({});
const transparentIcons = ref<Record<string, boolean>>({});
const iconLoads = new Map<string, Promise<void>>();

async function loadUncachedIcon(dirId: string, dirPath: string): Promise<void> {
  try {
    const icon = await useRpc().request.findProjectIcon({ dir: dirPath });
    const src = icon ? convertFileSrc(icon) : "";
    const isTransparent = icon
      ? await useRpc().request.projectIconHasTransparentBackground({ path: icon }).catch(() => false)
      : false;
    transparentIcons.value[dirId] = isTransparent;
    icons.value[dirId] = src;
  } catch {
    icons.value[dirId] = "";
    transparentIcons.value[dirId] = false;
  }
}

function loadIcon(dirId: string, dirPath: string): Promise<void> {
  const existing = iconLoads.get(dirId);
  if (existing) return existing;
  if (icons.value[dirId] !== undefined) return Promise.resolve();

  const load = loadUncachedIcon(dirId, dirPath).finally(() => iconLoads.delete(dirId));
  iconLoads.set(dirId, load);
  return load;
}

export function useProjectIcons() {
  return { icons, transparentIcons, loadIcon };
}
