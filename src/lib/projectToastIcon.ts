import type { FunctionalComponent, Ref } from "vue";
import { h } from "vue";

interface ProjectDirectory {
  id: string;
  path: string;
}

interface ProjectIconSource {
  icons: Ref<Record<string, string>>;
  transparentIcons: Ref<Record<string, boolean>>;
  loadIcon: (directoryId: string, path: string) => Promise<void>;
}

export function projectToastIcon(src: string, transparent: boolean): FunctionalComponent {
  return () => h("img", {
    src,
    class: [
      "size-5 shrink-0 rounded-xs object-contain ring-1 ring-black/10 dark:ring-white/10",
      transparent && "p-0.5",
    ],
    alt: "",
  });
}

export async function findFirstProjectToastIcon(
  directories: ProjectDirectory[],
  source: ProjectIconSource,
): Promise<FunctionalComponent | undefined> {
  for (const directory of directories) {
    await source.loadIcon(directory.id, directory.path);
    const src = source.icons.value[directory.id];
    if (src)
      return projectToastIcon(src, source.transparentIcons.value[directory.id] ?? false);
  }
  return undefined;
}
