// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBrowserTabOpenRequests } from "./browserTabOpenRequests";

const request = {
  requestId: "request-1",
  generation: 7,
  newTabId: "browser:requested",
  url: "https://example.com",
  workspaceDir: "/worktrees/feature",
  scopeType: "directory" as const,
  scopeId: "worktree-1",
  source: "mcp" as const,
  allowReuse: true,
};
const scope = {
  path: request.workspaceDir,
  scopeType: request.scopeType,
  scopeId: request.scopeId,
};

function emit(name: "browser-tab-open-request" | "browser-tab-open-cancel", detail = request): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveScope: vi.fn(async () => scope),
    activateScope: vi.fn(async () => {}),
    revealPanel: vi.fn(),
    openForScope: vi.fn(async () => ({
      tabId: request.newTabId, reused: false, created: true,
    })),
    rollbackForScope: vi.fn(async () => true),
    acknowledge: vi.fn(async () => true),
    ...overrides,
  };
}

describe("browser tab open requests", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("opens and activates an exact inactive worktree scope", async () => {
    const d = deps();
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-request");
    await vi.waitFor(() => expect(d.acknowledge).toHaveBeenCalled());

    expect(d.resolveScope).toHaveBeenCalledWith({
      path: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
    });
    expect(d.openForScope).toHaveBeenCalledWith(scope, request.url, {
      newTabId: request.newTabId, allowReuse: true,
    });
    expect(d.activateScope).toHaveBeenCalledWith(scope);
    expect(d.revealPanel).toHaveBeenCalledOnce();
    expect(d.acknowledge).toHaveBeenCalledWith({
      requestId: request.requestId,
      generation: request.generation,
      workspaceDir: request.workspaceDir,
      scopeType: request.scopeType,
      scopeId: request.scopeId,
      ok: true,
      tabId: request.newTabId,
      reused: false,
      created: true,
    });
  });

  it("rejects an exact scope that the renderer cannot resolve without targeting the active scope", async () => {
    const d = deps({ resolveScope: vi.fn(async () => null) });
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-request");
    await vi.waitFor(() => expect(d.acknowledge).toHaveBeenCalled());

    expect(d.openForScope).not.toHaveBeenCalled();
    expect(d.activateScope).not.toHaveBeenCalled();
    expect(d.acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId,
      generation: request.generation,
      ok: false,
      error: expect.stringContaining("not renderable"),
    }));
  });

  it("coalesces duplicate deliveries by request id", async () => {
    let finish!: (value: { tabId: string; reused: boolean; created: boolean }) => void;
    const opening = new Promise<{ tabId: string; reused: boolean; created: boolean }>((resolve) => {
      finish = resolve;
    });
    const d = deps({ openForScope: vi.fn(() => opening) });
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-request");
    emit("browser-tab-open-request");
    await vi.waitFor(() => expect(d.openForScope).toHaveBeenCalledTimes(1));
    finish({ tabId: request.newTabId, reused: false, created: true });
    await vi.waitFor(() => expect(d.acknowledge).toHaveBeenCalledTimes(2));

    expect(d.openForScope).toHaveBeenCalledTimes(1);
  });

  it("rolls back a newly-created tab when acknowledgement is lost", async () => {
    const d = deps({ acknowledge: vi.fn(async () => { throw new Error("renderer gone"); }) });
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-request");
    await vi.waitFor(() => expect(d.rollbackForScope).toHaveBeenCalled());

    expect(d.rollbackForScope).toHaveBeenCalledWith(scope, request.newTabId, request.url);
  });

  it("never rolls back a reused tab when acknowledgement is lost", async () => {
    const d = deps({
      openForScope: vi.fn(async () => ({ tabId: "browser:persisted", reused: true, created: false })),
      acknowledge: vi.fn(async () => { throw new Error("renderer gone"); }),
    });
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-request");
    await vi.waitFor(() => expect(d.acknowledge).toHaveBeenCalled());
    await Promise.resolve();

    expect(d.rollbackForScope).not.toHaveBeenCalled();
  });

  it("rolls back only the request-owned candidate when main cancels readiness", async () => {
    const d = deps();
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-cancel");
    await vi.waitFor(() => expect(d.rollbackForScope).toHaveBeenCalled());

    expect(d.rollbackForScope).toHaveBeenCalledWith(scope, request.newTabId, request.url);
  });

  it("rolls back an in-flight created tab exactly once and tombstones the cancelled request", async () => {
    let finish!: (value: { tabId: string; reused: boolean; created: boolean }) => void;
    const opening = new Promise<{ tabId: string; reused: boolean; created: boolean }>((resolve) => {
      finish = resolve;
    });
    const d = deps({ openForScope: vi.fn(() => opening) });
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-request");
    await vi.waitFor(() => expect(d.openForScope).toHaveBeenCalledOnce());
    emit("browser-tab-open-cancel");
    finish({ tabId: request.newTabId, reused: false, created: true });
    await vi.waitFor(() => expect(d.rollbackForScope).toHaveBeenCalled());

    expect(d.rollbackForScope).toHaveBeenCalledTimes(1);
    emit("browser-tab-open-request");
    await Promise.resolve();
    expect(d.openForScope).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate in-flight request id with different parameters", async () => {
    const opening = new Promise<never>(() => {});
    const d = deps({ openForScope: vi.fn(() => opening) });
    dispose = installBrowserTabOpenRequests(d);

    emit("browser-tab-open-request");
    emit("browser-tab-open-request", { ...request, url: "https://other.example" });
    await vi.waitFor(() => expect(d.acknowledge).toHaveBeenCalled());

    expect(d.openForScope).toHaveBeenCalledTimes(1);
    expect(d.acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.stringContaining("different parameters"),
    }));
  });
});
