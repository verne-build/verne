// Re-sign the prebuilt dev Electron binary with a Developer ID identity so
// macOS UNUserNotificationCenter delivers notifications in `pnpm dev`.
//
// Ad-hoc-signed apps (what the prebuilt ships as) are refused by macOS 13+ with
// `UNErrorDomain Code=1` (not allowed). A stable Developer ID signature fixes it.
// pnpm reinstalls re-extract the ad-hoc binary, so this runs from postinstall.
//
// No-ops (exit 0) on non-macOS or when no signing identity is present, so it
// never breaks install for other contributors or CI.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (process.platform !== "darwin") process.exit(0);

const APP = "node_modules/electron/dist/Electron.app";
if (!existsSync(APP)) {
  console.log("[sign-dev-electron] Electron.app not found yet, skipping.");
  process.exit(0);
}

function findIdentity() {
  let out = "";
  try {
    out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  // Prefer Developer ID Application; fall back to any Apple Development cert.
  const lines = out.split("\n");
  const pick = (re) => lines.find((l) => re.test(l))?.match(/"([^"]+)"/)?.[1] ?? null;
  return pick(/Developer ID Application/) ?? pick(/Apple Develop(ment|er)/);
}

const id = findIdentity();
if (!id) {
  console.log(
    "[sign-dev-electron] No codesigning identity found — leaving Electron ad-hoc.\n" +
      "  Dev notifications will fail with UNErrorDomain Code=1 until a\n" +
      '  "Developer ID Application" cert is installed (see SIGNING.md).',
  );
  process.exit(0);
}

try {
  execFileSync("codesign", ["--force", "--deep", "--sign", id, APP], { stdio: "inherit" });
  console.log(`[sign-dev-electron] Re-signed ${APP} with "${id}".`);
} catch (e) {
  console.error("[sign-dev-electron] codesign failed:", e.message);
  // Don't fail the install — dev still runs, just without notifications.
  process.exit(0);
}
