import { shell } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { registerNative } from "../ipc-router";

const pExecFile = promisify(execFile);

// Mirrors get_installed_ides in verne-tauri/src-tauri/src/commands/window.rs.
// Detection: .app path existence under /Applications (identical to Rust).
// Keys returned match Rust (e.g. "cursor", "vscode") not display names.
const IDES: { name: string; appPath: string }[] = [
  { name: "cursor",          appPath: "/Applications/Cursor.app" },
  { name: "antigravity",     appPath: "/Applications/Antigravity.app" },
  { name: "windsurf",        appPath: "/Applications/Windsurf.app" },
  { name: "zed",             appPath: "/Applications/Zed.app" },
  { name: "sublime",         appPath: "/Applications/Sublime Text.app" },
  { name: "xcode",           appPath: "/Applications/Xcode.app" },
  { name: "vscode",          appPath: "/Applications/Visual Studio Code.app" },
  { name: "vscode-insiders", appPath: "/Applications/Visual Studio Code - Insiders.app" },
  { name: "intellij",        appPath: "/Applications/IntelliJ IDEA.app" },
  { name: "webstorm",        appPath: "/Applications/WebStorm.app" },
  { name: "pycharm",         appPath: "/Applications/PyCharm.app" },
  { name: "phpstorm",        appPath: "/Applications/PhpStorm.app" },
  { name: "rubymine",        appPath: "/Applications/RubyMine.app" },
  { name: "goland",          appPath: "/Applications/GoLand.app" },
  { name: "clion",           appPath: "/Applications/CLion.app" },
  { name: "rider",           appPath: "/Applications/Rider.app" },
  { name: "datagrip",        appPath: "/Applications/DataGrip.app" },
  { name: "appcode",         appPath: "/Applications/AppCode.app" },
  { name: "fleet",           appPath: "/Applications/Fleet.app" },
  { name: "rustrover",       appPath: "/Applications/RustRover.app" },
  { name: "android-studio",  appPath: "/Applications/Android Studio.app" },
];

export function registerShellCommands(): void {
  // Rust uses `open -R <path>`; Electron's shell.showItemInFolder is equivalent.
  registerNative("reveal_in_finder", (p: { path: string }) => {
    shell.showItemInFolder(p.path);
    return true;
  });

  // Rust uses the `trash` crate (moves to Trash, no permanent delete).
  // Electron's shell.trashItem is the exact equivalent.
  registerNative("trash_file", async (p: { path: string }) => {
    await shell.trashItem(p.path);
    return true;
  });

  // Rust uses `open <url>` (macOS open command); shell.openExternal is equivalent.
  registerNative("open_external", async (p: { url: string }) => {
    await shell.openExternal(p.url);
  });

  registerNative("get_installed_ides", () =>
    IDES.filter((i) => existsSync(i.appPath)).map((i) => i.name)
  );

  // Rust: `open -a <appName> <dirPath>` — matched exactly.
  registerNative("open_in_ide", async (p: { appName: string; dirPath: string }) => {
    await pExecFile("open", ["-a", p.appName, p.dirPath]);
  });
}
