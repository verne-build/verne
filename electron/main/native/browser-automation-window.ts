import { BrowserWindow } from "electron";
import { CdpSession, type Debugger } from "./cdp-session";

export interface AutomationBrowserSession {
  session: CdpSession;
  dispose: () => void;
}

export async function createAutomationBrowserSession(
  tabId: string,
  url: string,
  workspaceDir: string,
): Promise<AutomationBrowserSession> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition: "persist:verne-browser",
    },
  });

  win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    win.webContents.loadURL(nextUrl).catch(() => {});
    return { action: "deny" };
  });

  const session = new CdpSession(
    tabId,
    win.webContents.id,
    workspaceDir,
    win.webContents.debugger as unknown as Debugger,
    { offscreen: true },
  );

  try {
    await session.attach();
    await session.beginNavigate(url);
    return {
      session,
      dispose: () => {
        if (!win.isDestroyed()) win.destroy();
      },
    };
  } catch (e) {
    session.detach();
    if (!win.isDestroyed()) win.destroy();
    throw e;
  }
}
