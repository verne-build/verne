export type UnlistenFn = () => void;

export function invoke<T>(method: string, params?: unknown): Promise<T> {
  return window.verne.invoke<T>(method, params);
}

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return window.verne.listen(event, (payload) => handler({ payload: payload as T }));
}

export function convertFileSrc(path: string): string {
  return window.verne.assetUrl(path);
}

export function filePathForFile(file: File): string {
  return window.verne.filePathForFile(file);
}

export async function openExternal(url: string): Promise<void> {
  await window.verne.invoke("open_external", { url });
}

export async function showSaveDialog(options?: { defaultPath?: string }): Promise<string | null> {
  return window.verne.invoke("show_save_dialog", { defaultPath: options?.defaultPath ?? null });
}

export async function openInIde(appName: string, dirPath: string): Promise<void> {
  await window.verne.invoke("open_in_ide", { appName, dirPath });
}

export async function getInstalledIdes(): Promise<string[]> {
  return window.verne.invoke("get_installed_ides");
}

export function startDragging(): void {
  // Electron: handled by CSS `-webkit-app-region: drag` on the title bar element.
}

export async function ask(
  message: string,
  options?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<boolean> {
  return window.verne.invoke("show_message_dialog", {
    message,
    title: options?.title ?? null,
    kind: options?.kind ?? null,
  });
}
