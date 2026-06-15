import { homedir } from "node:os";
import { join } from "node:path";

const isDev = !!process.env.ELECTRON_RENDERER_URL || process.env.NODE_ENV === "development";
// App-internal data dir, derived SOLELY from this app's own build identity
// (dev vs prod). Mirrors electron-builder.yml's appId; user settings live in
// ~/.verne via the Rust user_data_dir().
//
// Deliberately does NOT read VERNE_INTERNAL_DATA_DIR. The daemon injects that
// var into every PTY so in-terminal tooling (the notes/browser MCP server,
// the `verne` CLI) phones home to the instance that OWNS the terminal. A nested
// app launch — `pnpm dev` run from a terminal inside the running prod app —
// would otherwise inherit prod's dir, point Chromium's userData (and the
// single-instance lock) at build.verne, fail requestSingleInstanceLock, and
// quit. So dev couldn't run while prod was open. The app is authoritative about
// its own dirs and passes the resolved value to its Rust children explicitly
// (see daemon-supervisor); only child tooling honors the inherited override.
export const internalDataDir =
  join(homedir(), "Library", "Application Support", isDev ? "build.verne-dev" : "build.verne");
export const socketPath = join(internalDataDir, "verne.sock");
export const sidecarSocketPath = join(internalDataDir, "verne-sidecar.sock");
export const wsPort = isDev ? 9601 : 9600;
export const daemonLog = join(internalDataDir, "verne-server.log");
export const sidecarLog = join(internalDataDir, "verne-sidecar.log");
