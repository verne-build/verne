import { systemPreferences } from "electron";
import type { BrowserWindow } from "electron";
import { registerNative } from "../ipc-router";
import { SPEECH_MODEL_CATALOG, getCatalogModel } from "./model-catalog";
import { getSpeechModelManager, getSpeechSttService } from "./speech-runtime-service";
import { setHotkeyConfig, type HotkeyConfig } from "./hotkey";
import type { SttEvent } from "./stt-service";

// All speech events ride Verne's existing "daemon-event" bus so no preload
// change is needed: the renderer subscribes via listen("speech:...").
export function registerSpeechIpc(getWindow: () => BrowserWindow): void {
  const emit = (name: string, payload: unknown): void => {
    const win = getWindow();
    if (!win.isDestroyed()) win.webContents.send("daemon-event", name, payload);
  };

  registerNative("speech:getCatalog", () => SPEECH_MODEL_CATALOG);

  registerNative("speech:getModelStates", () => getSpeechModelManager().getModelStates());

  registerNative("speech:downloadModel", async (p: { modelId: string }) => {
    const manager = getSpeechModelManager();
    const clear = manager.setProgressCallback((state) =>
      emit("speech:downloadProgress", { modelId: state.id, ...state }),
    );
    try {
      await manager.downloadModel(p.modelId);
    } finally {
      clear();
    }
  });

  registerNative("speech:cancelDownload", (p: { modelId: string }) =>
    getSpeechModelManager().cancelDownload(p.modelId),
  );

  registerNative("speech:deleteModel", async (p: { modelId: string }) => {
    if (!getCatalogModel(p.modelId)) throw new Error(`Unknown model: ${p.modelId}`);
    await getSpeechModelManager().deleteModel(p.modelId);
  });

  registerNative("speech:setHotkeyConfig", (p: Partial<HotkeyConfig>) => {
    setHotkeyConfig(p);
    return true;
  });

  registerNative("speech:startDictation", async (p: { modelId: string; sessionId?: string }) => {
    const sessionId = p.sessionId ?? "desktop";
    const owner = `desktop:${sessionId}`;
    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status !== "granted") {
        await systemPreferences.askForMediaAccess("microphone");
        if (systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
          throw new Error(
            "Microphone access not granted. Enable it in System Settings > Privacy & Security > Microphone.",
          );
        }
      }
    }
    try {
      await getSpeechSttService().startDictation(
      p.modelId,
      (msg: SttEvent) => {
        switch (msg.type) {
          case "ready":
            emit("speech:ready", { sessionId });
            break;
          case "partial":
            emit("speech:partial", { text: msg.text ?? "", sessionId });
            break;
          case "final":
            emit("speech:final", { text: msg.text ?? "", sessionId });
            break;
          case "stopped":
            emit("speech:stopped", { sessionId });
            break;
          case "error":
            console.error("[speech] worker error:", msg.error);
            emit("speech:error", { error: msg.error ?? "", sessionId });
            void getSpeechSttService().stopDictation(owner).catch(() => undefined);
            break;
        }
      },
      undefined,
      owner,
      );
    } catch (err) {
      console.error("[speech] startDictation failed:", err);
      throw err;
    }
  });

  registerNative(
    "speech:feedAudio",
    (p: { buffer: Uint8Array; sampleRate: number; sessionId?: string }) => {
      const sessionId = p.sessionId ?? "desktop";
      const u8 = p.buffer instanceof Uint8Array ? p.buffer : new Uint8Array(p.buffer);
      const samples = new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
      getSpeechSttService().feedAudio(samples, p.sampleRate, `desktop:${sessionId}`);
    },
  );

  registerNative("speech:stopDictation", async (p: { sessionId?: string }) => {
    await getSpeechSttService().stopDictation(`desktop:${p.sessionId ?? "desktop"}`);
  });
}
