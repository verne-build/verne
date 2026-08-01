import type { AgentInventoryKey } from "../../../src/types/agentInventory";

/** Sentinel used when discovery fails before any agent row exists. */
export const INVENTORY_DIAGNOSTIC_KEY = "inventory" as const;

export type InventoryDiagnosticKey = AgentInventoryKey | typeof INVENTORY_DIAGNOSTIC_KEY;

export type InventoryDiagnosticCode =
  | "discovery-rejected"
  | "version-exec"
  | "version-timeout"
  | "version-output-cap"
  | "version-parse"
  | "version-nonzero"
  | "latest-http-status"
  | "latest-fetch"
  | "latest-fetch-timeout"
  | "latest-body-cap"
  | "latest-parse"
  | "latest-cli-timeout"
  | "latest-cli-exec"
  | "latest-cli-output-cap"
  | "latest-cli-parse";

export interface InventoryDiagnosticEvent {
  key: InventoryDiagnosticKey;
  code: InventoryDiagnosticCode;
  durationMs: number;
  httpStatus: number | null;
}

export type InventoryDiagnosticLogger = (event: InventoryDiagnosticEvent) => void;

export interface InventoryDiagnosticDeps {
  diagnostic?: InventoryDiagnosticLogger;
  now?: () => number;
}

export const CONSOLE_INVENTORY_DIAGNOSTIC_LOGGER: InventoryDiagnosticLogger = (event) => {
  console.warn(`[agent-inventory] ${JSON.stringify(event)}`);
};

export function diagnosticStart(deps: InventoryDiagnosticDeps): number {
  return safeNow(deps.now);
}

export function diagnosticDuration(deps: InventoryDiagnosticDeps, startedAt: number): number {
  const elapsed = safeNow(deps.now) - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

export function reportDiagnostic(
  deps: InventoryDiagnosticDeps,
  key: InventoryDiagnosticKey,
  code: InventoryDiagnosticCode,
  startedAt: number,
  httpStatus: number | null = null,
): void {
  emitDiagnostic(deps, key, code, diagnosticDuration(deps, startedAt), httpStatus);
}

export function emitDiagnostic(
  deps: InventoryDiagnosticDeps,
  key: InventoryDiagnosticKey,
  code: InventoryDiagnosticCode,
  durationMs: number,
  httpStatus: number | null = null,
): void {
  try {
    deps.diagnostic?.({
      key,
      code,
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
      httpStatus,
    });
  } catch {
    // Diagnostics must never change inventory behavior.
  }
}

function safeNow(now: (() => number) | undefined): number {
  try {
    const value = (now ?? Date.now)();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
