import { protocol, net } from "electron";
import { pathToFileURL } from "node:url";
import { realpath, stat } from "node:fs/promises";
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

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single `bytes=` range. Returns null for syntaxes we don't handle
 * (multi-range, garbage) so the caller can fall back to a full 200 response,
 * and "invalid" for a valid syntax that can't be satisfied (→ 416).
 */
export function parseByteRange(header: string, size: number): ByteRange | "invalid" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
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

    // net.fetch on file:// returns no Content-Length/Accept-Ranges and answers a
    // Range request with 200 (sliced body, no Content-Range). Media elements need
    // a real 206 to know the file size and seek, so synthesize the headers here.
    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) return new Response(null, { status: 404 });

    const fileUrl = pathToFileURL(real).toString();
    const rangeHeader = request.headers.get("range");

    if (rangeHeader) {
      const range = parseByteRange(rangeHeader, info.size);
      if (range === "invalid") {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}`, "Accept-Ranges": "bytes" },
        });
      }
      if (range) {
        const upstream = await net.fetch(fileUrl, {
          headers: { Range: `bytes=${range.start}-${range.end}` },
        });
        const headers = new Headers(upstream.headers);
        headers.set("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
        headers.set("Content-Length", String(range.end - range.start + 1));
        headers.set("Accept-Ranges", "bytes");
        return new Response(upstream.body, {
          status: 206,
          statusText: "Partial Content",
          headers,
        });
      }
    }

    const upstream = await net.fetch(fileUrl);
    const headers = new Headers(upstream.headers);
    headers.set("Content-Length", String(info.size));
    headers.set("Accept-Ranges", "bytes");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  });
}
