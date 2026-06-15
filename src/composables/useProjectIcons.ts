import { ref } from "vue";
import { useRpc } from "@/composables/useRpc";
import { convertFileSrc } from "@/platform";

const icons = ref<Record<string, string>>({});

async function loadIcon(dirId: string, dirPath: string) {
  if (icons.value[dirId] !== undefined) return;
  try {
    const icon = await useRpc().request.findProjectIcon({ dir: dirPath });
    icons.value[dirId] = icon ? convertFileSrc(icon) : "";
  } catch {
    icons.value[dirId] = "";
  }
}

export function useProjectIcons() {
  return { icons, loadIcon };
}
