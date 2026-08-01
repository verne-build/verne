import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { AgentInventorySnapshot } from "../../../src/types/agentInventory";

const handlers = vi.hoisted(() => new Map<string, (params: unknown) => unknown>());

vi.mock("../ipc-router", () => ({
  registerNative: (method: string, handler: (params: unknown) => unknown) => {
    handlers.set(method, handler);
  },
}));

import {
  registerAgentInventoryCommands,
  startAgentInventoryAfterWindow,
} from "./agent-inventory-cmds";

const snapshot: AgentInventorySnapshot = {
  schemaVersion: 1,
  agents: [],
  checkedAt: "2026-07-31T12:00:00.000Z",
  expiresAt: "2026-07-31T13:00:00.000Z",
  refreshError: null,
};

async function invokeRegistered(method: string, params: unknown): Promise<unknown> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`missing handler: ${method}`);
  return handler(params);
}

describe("agent inventory native commands", () => {
  it("registers pull and forced refresh handlers", async () => {
    const service = {
      get: vi.fn(() => snapshot),
      refresh: vi.fn(async () => snapshot),
    };

    registerAgentInventoryCommands(service as never);

    expect(await invokeRegistered("agent_inventory_get", {})).toEqual(snapshot);
    expect(await invokeRegistered("agent_inventory_refresh", {})).toEqual(snapshot);
    expect(service.refresh).toHaveBeenCalledTimes(1);
  });

  it("creates the window before starting inventory refresh", () => {
    const order: string[] = [];
    const fakeWindow = {} as BrowserWindow;
    const pending = new Promise<AgentInventorySnapshot>(() => {});

    const result = startAgentInventoryAfterWindow(
      () => {
        order.push("window");
        return fakeWindow;
      },
      {
        refreshIfStale: () => {
          order.push("refresh");
          return pending;
        },
      },
    );

    expect(result).toBe(fakeWindow);
    expect(order).toEqual(["window", "refresh"]);
  });
});
