import crypto from "node:crypto";
import type { BrowserWindow } from "electron";
import type { BrowserTabOpenAck, BrowserTabOpenRequest } from "../../../src/types/shared";
import { registerNative } from "../ipc-router";
import type { BrowserRegistry } from "./browser-registry";

export type BrowserTabRelayOpenRequest = Omit<BrowserTabOpenRequest, "requestId">;

interface PendingAck {
  tabId: string;
  workspaceDir: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RelayOptions {
  timeoutMs?: number;
  createId?: () => string;
}

export class BrowserTabRelay {
  private pending = new Map<string, PendingAck>();
  private timeoutMs: number;
  private createId: () => string;

  constructor(
    private registry: BrowserRegistry,
    private getWindow: () => BrowserWindow,
    options: RelayOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  installIpc(): void {
    registerNative("native_browser_tab_open_ack", (ack: BrowserTabOpenAck) => this.acknowledge(ack));
  }

  async open(request: BrowserTabRelayOpenRequest): Promise<string> {
    const win = this.getWindow();
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("browser tab renderer unavailable");
    }
    const requestId = this.createId();
    const ack = new Promise<void>((resolve, reject) => {
      const pending: PendingAck = {
        tabId: request.tabId,
        workspaceDir: request.workspaceDir,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`renderer did not acknowledge browser tab ${request.tabId} within ${this.timeoutMs}ms`));
        }, this.timeoutMs),
      };
      this.pending.set(requestId, pending);
    });

    try {
      win.webContents.send("daemon-event", "browser-tab-open-request", { requestId, ...request });
    } catch (error) {
      this.rejectPending(requestId, error instanceof Error ? error : new Error(String(error)));
    }

    await ack;
    await this.registry.waitForUi(request.tabId, request.workspaceDir, this.timeoutMs);
    return request.tabId;
  }

  acknowledge(ack: BrowserTabOpenAck): boolean {
    const pending = this.pending.get(ack.requestId);
    if (!pending || pending.tabId !== ack.tabId || pending.workspaceDir !== ack.workspaceDir) return false;
    clearTimeout(pending.timer);
    this.pending.delete(ack.requestId);
    if (ack.ok) pending.resolve();
    else pending.reject(new Error(ack.error || `renderer rejected browser tab ${ack.tabId}`));
    return true;
  }

  dispose(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.rejectPending(requestId, new Error("browser tab relay disposed"));
    }
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }
}
