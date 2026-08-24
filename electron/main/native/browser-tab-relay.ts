import crypto from "node:crypto";
import type { BrowserWindow } from "electron";
import type {
  BrowserTabOpenAck,
  BrowserTabOpenRequest,
  BrowserTabOpenResult,
} from "../../../src/types/shared";
import { registerNative } from "../ipc-router";
import type { BrowserRegistry } from "./browser-registry";

export type BrowserTabRelayOpenRequest = Omit<BrowserTabOpenRequest, "requestId" | "generation">;

interface PendingRequest {
  requestId: string;
  request: BrowserTabRelayOpenRequest;
  resolve: (result: BrowserTabOpenResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sentGeneration?: number;
  ack?: BrowserTabOpenResult;
  readiness?: AbortController;
}
interface PendingCancellation {
  requestId: string;
  request: BrowserTabRelayOpenRequest;
  sentGeneration?: number;
}

interface RelayOptions {
  timeoutMs?: number;
  createId?: () => string;
}

export class BrowserTabRelay {
  private pending = new Map<string, PendingRequest>();
  private cancellations = new Map<string, PendingCancellation>();
  private timeoutMs: number;
  private createId: () => string;
  private attachedWindow: BrowserWindow | null = null;
  private hostWebContentsId: number | null = null;
  private generation = 0;
  private rendererReady = false;
  private onNavigation?: (...args: any[]) => void;
  private onWebContentsDestroyed?: () => void;
  private onWindowClosed?: () => void;

  constructor(
    private registry: BrowserRegistry,
    private getWindow: () => BrowserWindow,
    options: RelayOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  installIpc(): void {
    registerNative("native_browser_tab_open_ack", (ack: BrowserTabOpenAck, win, event) =>
      event.sender.id === win.webContents.id ? this.acknowledge(ack) : false);
    registerNative("native_browser_relay_ready", (_params, win, event) =>
      event.sender.id === win.webContents.id ? this.markRendererReady(win) : false);
  }

  attachWindow(win: BrowserWindow): void {
    if (this.attachedWindow === win && this.hostWebContentsId === win.webContents.id) return;
    const previousHost = this.hostWebContentsId;
    this.removeWindowListeners();
    if (previousHost !== null) this.registry.unregisterUiForHost?.(previousHost);
    this.attachedWindow = win;
    this.hostWebContentsId = win.webContents.id;
    this.advanceGeneration(true);

    this.onNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isInPlace || !isMainFrame || this.attachedWindow !== win) return;
      this.registry.unregisterUiForHost?.(win.webContents.id);
      this.advanceGeneration(true);
    };
    this.onWebContentsDestroyed = () => {
      if (this.attachedWindow !== win) return;
      this.registry.unregisterUiForHost?.(win.webContents.id);
      this.rendererReady = false;
      this.restartPending();
    };
    this.onWindowClosed = this.onWebContentsDestroyed;
    win.webContents.on("did-start-navigation", this.onNavigation);
    win.webContents.on("destroyed", this.onWebContentsDestroyed);
    win.on("closed", this.onWindowClosed);
  }

  markRendererReady(win: BrowserWindow): number {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("browser tab renderer unavailable");
    }
    if (this.attachedWindow !== win || this.hostWebContentsId !== win.webContents.id) {
      this.attachWindow(win);
    }
    this.rendererReady = true;
    for (const pending of this.pending.values()) this.dispatch(pending);
    for (const cancellation of this.cancellations.values()) this.dispatchCancellation(cancellation);
    return this.generation;
  }

  open(request: BrowserTabRelayOpenRequest): Promise<BrowserTabOpenResult> {
    const win = this.getWindow();
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      return Promise.reject(new Error("browser tab renderer unavailable"));
    }
    if (this.attachedWindow !== win || this.hostWebContentsId !== win.webContents.id) {
      this.attachWindow(win);
    }

    const requestId = this.createId();
    const result = new Promise<BrowserTabOpenResult>((resolve, reject) => {
      const pending: PendingRequest = {
        requestId,
        request,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(
            pending,
            new Error(`browser tab request ${requestId} did not complete within ${this.timeoutMs}ms`),
          );
        }, this.timeoutMs),
      };
      this.pending.set(requestId, pending);
      this.dispatch(pending);
    });
    return result;
  }

  acknowledge(ack: BrowserTabOpenAck): boolean {
    const pending = this.pending.get(ack.requestId);
    if (
      !pending
      || ack.generation !== this.generation
      || pending.sentGeneration !== ack.generation
      || ack.workspaceDir !== pending.request.workspaceDir
      || ack.scopeType !== pending.request.scopeType
      || ack.scopeId !== pending.request.scopeId
    ) return false;
    if (!ack.ok) {
      this.fail(pending, new Error(ack.error || `renderer rejected browser tab ${pending.request.newTabId}`));
      return true;
    }
    if (!ack.tabId || ack.reused === undefined || ack.created === undefined) {
      this.fail(pending, new Error("renderer returned an incomplete browser tab acknowledgement"));
      return true;
    }
    if (
      ack.reused === ack.created
      || (ack.created && ack.tabId !== pending.request.newTabId)
    ) {
      this.fail(pending, new Error("renderer returned an invalid browser tab acknowledgement"));
      return true;
    }

    const result: BrowserTabOpenResult = {
      tabId: ack.tabId,
      reused: ack.reused,
      created: ack.created,
    };
    pending.ack = result;
    pending.readiness?.abort();
    const readiness = new AbortController();
    pending.readiness = readiness;
    const hostWebContentsId = this.hostWebContentsId;
    Promise.resolve(this.registry.waitForUi(
      result.tabId,
      pending.request.workspaceDir,
      this.timeoutMs,
      {
        hostWebContentsId: hostWebContentsId ?? undefined,
        signal: readiness.signal,
      },
    )).then(() => {
      if (
        this.pending.get(pending.requestId) !== pending
        || readiness.signal.aborted
        || pending.sentGeneration !== this.generation
      ) return;
      this.succeed(pending, result);
    }).catch((error) => {
      if (readiness.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
      if (this.pending.get(pending.requestId) === pending) {
        this.fail(pending, error instanceof Error ? error : new Error(String(error)));
      }
    });
    return true;
  }

  dispose(): void {
    this.removeWindowListeners();
    for (const pending of [...this.pending.values()]) {
      this.fail(pending, new Error("browser tab relay disposed"));
    }
    this.cancellations.clear();
    this.attachedWindow = null;
    this.hostWebContentsId = null;
    this.rendererReady = false;
  }

  private advanceGeneration(restart: boolean): void {
    this.generation++;
    this.rendererReady = false;
    if (restart) this.restartPending();
  }

  private restartPending(): void {
    for (const pending of this.pending.values()) {
      pending.readiness?.abort();
      pending.readiness = undefined;
      pending.ack = undefined;
      pending.sentGeneration = undefined;
    }
  }

  private dispatch(pending: PendingRequest): void {
    if (!this.rendererReady || pending.sentGeneration === this.generation) return;
    const win = this.attachedWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const payload: BrowserTabOpenRequest = {
      requestId: pending.requestId,
      generation: this.generation,
      ...pending.request,
    };
    try {
      win.webContents.send("daemon-event", "browser-tab-open-request", payload);
      pending.sentGeneration = this.generation;
    } catch {
      this.rendererReady = false;
      pending.sentGeneration = undefined;
    }
  }

  private succeed(pending: PendingRequest, result: BrowserTabOpenResult): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.requestId);
    pending.resolve(result);
  }

  private fail(pending: PendingRequest, error: Error): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    clearTimeout(pending.timer);
    pending.readiness?.abort();
    this.pending.delete(pending.requestId);
    if (!pending.ack || pending.ack.created) this.queueCancellation(pending);
    pending.reject(error);
  }

  private queueCancellation(pending: PendingRequest): void {
    const cancellation: PendingCancellation = {
      requestId: pending.requestId,
      request: pending.request,
    };
    this.cancellations.set(pending.requestId, cancellation);
    if (this.cancellations.size > 100) {
      this.cancellations.delete(this.cancellations.keys().next().value!);
    }
    this.dispatchCancellation(cancellation);
  }

  private dispatchCancellation(cancellation: PendingCancellation): void {
    if (!this.rendererReady || cancellation.sentGeneration === this.generation) return;
    const win = this.attachedWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const payload: BrowserTabOpenRequest = {
      requestId: cancellation.requestId,
      generation: this.generation,
      ...cancellation.request,
    };
    try {
      win.webContents.send("daemon-event", "browser-tab-open-cancel", payload);
      cancellation.sentGeneration = this.generation;
    } catch {
      // A future renderer-ready generation retries this idempotent rollback.
    }
  }

  private removeWindowListeners(): void {
    const win = this.attachedWindow;
    if (!win) return;
    if (this.onNavigation) win.webContents.removeListener("did-start-navigation", this.onNavigation);
    if (this.onWebContentsDestroyed) win.webContents.removeListener("destroyed", this.onWebContentsDestroyed);
    if (this.onWindowClosed) win.removeListener("closed", this.onWindowClosed);
    this.onNavigation = undefined;
    this.onWebContentsDestroyed = undefined;
    this.onWindowClosed = undefined;
  }
}
