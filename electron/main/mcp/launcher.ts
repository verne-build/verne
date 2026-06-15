import { app } from "electron";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { internalDataDir } from "../paths";

/** Stable path agents invoke; rewritten each launch (paths can change on update). */
export function mcpLauncherPath(): string {
  return join(internalDataDir, "verne-mcp");
}

function mcpServerCjsPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "app.asar.unpacked", "out", "main", "mcp-server.cjs");
  }
  return join(app.getAppPath(), "out", "main", "mcp-server.cjs");
}

/** Write a shell launcher that runs the bundled MCP server via Electron-as-node,
 *  so agents need no system `node`. Inherits the agent's env (VERNE_WORKSPACE_DIR…). */
export function writeMcpLauncher(): void {
  const cjs = mcpServerCjsPath();
  const script = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${process.execPath}" "${cjs}" "$@"\n`;
  const path = mcpLauncherPath();
  mkdirSync(internalDataDir, { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}
