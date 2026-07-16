import { protocol, net } from "electron";
import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

// Must be called BEFORE app.whenReady (privileged scheme registration).
export function registerAssetSchemePrivilege(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "verne-asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // TODO: drop bypassCSP once a CSP is in place (see review-suggestions security section)
        bypassCSP: true,
      },
    },
  ]);
}

// Robust containment: true iff realPath is the root itself or lives under it.
// Uses path.relative (NOT raw startsWith, which is prefix-spoofable e.g.
// "/workspace-evil" vs "/workspace"). Caller must canonicalize both realPath
// and the roots (realpath) first so symlinks/`..` can't escape.
export function isPathAllowed(realPath: string, allowedRoots: string[]): boolean {
  for (const root of allowedRoots) {
    const rel = relative(root, realPath);
    if (rel === "") return true; // exact root
    if (!rel.startsWith("..") && !isAbsolute(rel)) return true;
  }
  return false;
}

// Call after app.whenReady. `getAllowedRoots` returns the live set of roots the
// scheme may serve from: open workspace/worktree directory paths (DB), the app
// resource dir, and the internal data dir. See registerExtraNatives in index.ts.
export function handleAssetProtocol(getAllowedRoots: () => string[]): void {
  protocol.handle("verne-asset", async (request) => {
    const url = new URL(request.url); // verne-asset://local/<encoded absolute path>
    const filePath = decodeURIComponent(url.pathname); // pathname is the absolute path, already leading-slash

    let real: string;
    try {
      real = await realpath(filePath); // resolves `..` + symlinks; throws if missing
    } catch {
      return new Response(null, { status: 404 });
    }

    // Canonicalize roots too so a symlinked root still matches; skip missing ones.
    const roots: string[] = [];
    for (const root of getAllowedRoots()) {
      try {
        roots.push(await realpath(root));
      } catch {
        // ignore roots that don't resolve
      }
    }

    if (!isPathAllowed(real, roots)) {
      console.warn(`verne-asset: rejected out-of-allowlist path: ${real}`);
      return new Response(null, { status: 404 });
    }

    return net.fetch(pathToFileURL(real).toString());
  });
}
