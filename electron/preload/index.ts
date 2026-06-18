import { contextBridge, ipcRenderer } from "electron";

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
  assetUrl: (path: string) => `verne-asset://local/${encodeURI(path)}`,
});
