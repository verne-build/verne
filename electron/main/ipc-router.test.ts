import { describe, it, expect, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { DaemonClient } from "./daemon-client";

// makeForward reads the singleton db via getDb() when consuming session-cwd —
// back it with an in-memory db instead of the real app-data-dir file.
vi.mock("./db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/connection")>();
  const memDb = actual.openDb(":memory:");
  return { ...actual, getDb: () => memDb };
});

import { makeForward } from "./ipc-router";
import { getDb } from "./db/connection";
import { insertDirectory } from "./db/directories";
import { insertTab, getTab } from "./db/tabs";

const sidecar = { request: vi.fn(async () => null) } as unknown as DaemonClient;

// Fake window matching only the surface makeForward touches.
function fakeWin(opts: { winDestroyed?: boolean; wcDestroyed?: boolean }) {
  const send = vi.fn();
  const win = {
    isDestroyed: () => opts.winDestroyed ?? false,
    webContents: { isDestroyed: () => opts.wcDestroyed ?? false, send },
  } as unknown as BrowserWindow;
  return { win, send };
}

describe("makeForward", () => {
  it("sends to a live window", () => {
    const { win, send } = fakeWin({});
    makeForward(() => win, sidecar)("evt", { a: 1 });
    expect(send).toHaveBeenCalledWith("daemon-event", "evt", { a: 1 });
  });

  // Daemon survives app close and keeps streaming; forward must not throw when
  // the window is gone (macOS keeps the app alive after window close).
  it("no-ops when getWindow throws (no window)", () => {
    const fwd = makeForward(() => { throw new Error("no window"); }, sidecar);
    expect(() => fwd("evt", {})).not.toThrow();
  });

  it("no-ops on a destroyed window", () => {
    const { win, send } = fakeWin({ winDestroyed: true });
    makeForward(() => win, sidecar)("evt", {});
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when webContents is destroyed", () => {
    const { win, send } = fakeWin({ wcDestroyed: true });
    makeForward(() => win, sidecar)("evt", {});
    expect(send).not.toHaveBeenCalled();
  });

  // session-cwd is main-internal: it resolves a scope re-pin via handleSessionCwd
  // and must never be forwarded raw to the renderer as a "daemon-event".
  it("consumes session-cwd instead of forwarding it", async () => {
    const { win, send } = fakeWin({});
    makeForward(() => win, sidecar)("session-cwd", { tabId: "unknown-tab", cwd: "/tmp" });
    // handleSessionCwd runs fire-and-forget (void ...catch) — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(send).not.toHaveBeenCalledWith("daemon-event", "session-cwd", expect.anything());
  });

  // agent-title-requested is main-internal: index.ts's own d0.onEvent listener
  // does the generation work. makeForward must consume it, not broadcast the
  // raw payload (prompts can carry multi-MB hook bodies) to a renderer with no
  // listener for it.
  it("consumes agent-title-requested instead of forwarding it", () => {
    const { win, send } = fakeWin({});
    makeForward(() => win, sidecar)("agent-title-requested", { tabId: "t1", prompt: "hi" });
    expect(send).not.toHaveBeenCalled();
  });

  // The renderer can't derive resumeAvailable (resume-registry is main-side) and
  // only refreshes rows on tabs_list/create/rename/archive — so tab-updated must
  // carry the LATCHED identity, not the daemon's (which nulls on agent exit).
  it("stamps latched identity + resumeAvailable on tab-updated", () => {
    const db = getDb();
    insertDirectory(db, { id: "dr", path: "/tmp/dr", name: "dr", createdAt: 0, sortOrder: 0 });
    insertTab(db, {
      id: "tr", directoryId: "dr", label: "1", cwd: "/tmp/dr",
      sortOrder: 0, createdAt: 0, userRenamed: false,
    });
    const { win, send } = fakeWin({});
    const fwd = makeForward(() => win, sidecar);

    // Hook lands the session id — payload must now advertise resume.
    fwd("tab-updated", {
      tabId: "tr", agentType: "claude", agentState: "working", lastAgentSessionId: "sid-1",
    });
    expect(send).toHaveBeenLastCalledWith("daemon-event", "tab-updated", expect.objectContaining({
      lastAgentType: "claude",
      lastAgentSessionId: "sid-1",
      resumeAvailable: true,
    }));

    // Agent quits: daemon publishes nulls, latched values still ride the event.
    fwd("tab-updated", { tabId: "tr", agentType: null, agentState: null });
    expect(send).toHaveBeenLastCalledWith("daemon-event", "tab-updated", expect.objectContaining({
      lastAgentType: "claude",
      lastAgentSessionId: "sid-1",
      resumeAvailable: true,
    }));
    expect(getTab(db, "tr")!.lastAgentState).toBeUndefined();
  });
});
