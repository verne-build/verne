import { contextBridge, ipcRenderer, webUtils } from "electron";

const listeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on("daemon-event", (_e, name: string, payload: unknown) => {
  listeners.get(name)?.forEach((fn) => fn(payload));
});

contextBridge.exposeInMainWorld("verne", {
  invoke: (method: string, params?: unknown) =>
    ipcRenderer.invoke("invoke", method, params),
  listen: (event: string, handler: (payload: unknown) => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler); // UnlistenFn
  },
  // encodeURI leaves `#`/`?` alone, which would truncate the URL into a fragment
  // or query — escape them so filenames like `clip #2.mp4` still resolve.
  assetUrl: (path: string) => `verne-asset://local/${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`,
  filePathForFile: (file: File) => webUtils.getPathForFile(file),
});
