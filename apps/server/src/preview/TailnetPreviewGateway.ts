// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";

import { guardHttpResponseWriteErrors } from "../httpResponseErrorGuard.ts";
import type { TailnetPreviewAuth } from "./TailnetPreviewAuth.ts";

export const TAILNET_PREVIEW_AUTH_PATH = "/.well-known/verne-preview/auth";

export interface TailnetPreviewTarget {
  readonly host: string;
  readonly port: number;
}

export interface TailnetPreviewGatewayOptions {
  readonly auth: TailnetPreviewAuth["Service"];
  readonly environmentId: string;
  readonly leaseId: string;
  readonly target: TailnetPreviewTarget;
}

export interface RunningTailnetPreviewGateway {
  readonly gatewayPort: number;
  readonly target: TailnetPreviewTarget;
  readonly close: Effect.Effect<void>;
}

export class TailnetPreviewGatewayStartError extends Error {
  override readonly name = "TailnetPreviewGatewayStartError";

  constructor(cause: unknown) {
    super("Failed to start the Tailnet preview gateway", { cause });
  }
}

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const bootstrapScript = String.raw`(()=>{const fragment=location.hash.slice(1);history.replaceState(null,"",location.pathname+location.search);let payload;try{payload=JSON.parse(decodeURIComponent(fragment))}catch{return}if(typeof payload.launchSecret!=="string"||typeof payload.target!=="string")return;const form=document.createElement("form");form.method="POST";form.action=location.pathname;for(const name of ["launchSecret","target"]){const input=document.createElement("input");input.type="hidden";input.name=name;input.value=payload[name];form.append(input)}document.body.append(form);form.submit()})()`;
const bootstrapScriptHash = NodeCrypto.createHash("sha256")
  .update(bootstrapScript)
  .digest("base64");
const bootstrapDocument = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>${bootstrapScript}</script>`;

const connectionHeaderNames = (headers: NodeHttp.IncomingHttpHeaders) =>
  new Set(
    (Array.isArray(headers.connection) ? headers.connection.join(",") : (headers.connection ?? ""))
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );

const removeGatewayCookie = (cookieHeader: string | undefined, cookieName: string) => {
  if (cookieHeader === undefined) return undefined;
  const remaining = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0 && cookie.split("=", 1)[0] !== cookieName);
  return remaining.length === 0 ? undefined : remaining.join("; ");
};

const sessionSecretFromCookie = (cookieHeader: string | undefined, cookieName: string) => {
  if (cookieHeader === undefined) return undefined;
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== cookieName) continue;
    const value = cookie.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
};

const filteredHeaders = (
  headers: NodeHttp.IncomingHttpHeaders,
  cookieName: string,
  target: TailnetPreviewTarget,
  preserveUpgrade: boolean,
) => {
  const connectionNames = connectionHeaderNames(headers);
  const output: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith("x-verne-")) continue;
    if ((!preserveUpgrade && hopByHopHeaders.has(lowerName)) || connectionNames.has(lowerName)) {
      continue;
    }
    if (lowerName === "cookie") {
      const cookie = removeGatewayCookie(
        Array.isArray(value) ? value.join("; ") : value,
        cookieName,
      );
      if (cookie !== undefined) output.cookie = cookie;
      continue;
    }
    if (value !== undefined) output[lowerName] = value;
  }

  output.host = `${target.host}:${target.port}`;
  if (headers.origin !== undefined) output.origin = `http://${target.host}:${target.port}`;
  if (preserveUpgrade) {
    output.connection = "Upgrade";
    if (headers.upgrade !== undefined) output.upgrade = headers.upgrade;
  }
  return output;
};

const filteredResponseHeaders = (headers: NodeHttp.IncomingHttpHeaders) => {
  const connectionNames = connectionHeaderNames(headers);
  const output: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      lowerName.startsWith("x-verne-") ||
      hopByHopHeaders.has(lowerName) ||
      connectionNames.has(lowerName)
    ) {
      continue;
    }
    if (value !== undefined) output[lowerName] = value;
  }
  return output;
};

const isValidatedRelativeTarget = (target: unknown): target is string => {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    [...target].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return false;
  }
  try {
    const base = "https://preview.invalid";
    const parsed = new URL(target, base);
    return parsed.origin === base && `${parsed.pathname}${parsed.search}${parsed.hash}` === target;
  } catch {
    return false;
  }
};

const endText = (
  response: NodeHttp.ServerResponse,
  status: number,
  body: string,
  headers: NodeHttp.OutgoingHttpHeaders = {},
) => {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
};

const writeSocketResponse = (socket: NodeStream.Duplex, status: number, phrase: string) => {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

const readAuthenticationBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error("authentication body too large"));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
        if (contentType === "application/x-www-form-urlencoded") {
          const form = new URLSearchParams(text);
          resolve({ launchSecret: form.get("launchSecret"), target: form.get("target") });
          return;
        }
        resolve(JSON.parse(text));
      } catch (cause) {
        reject(cause);
      }
    });
    request.on("error", reject);
  });

const listenLoopback = (server: NodeHttp.Server) =>
  new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("preview gateway did not receive a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });

export const startTailnetPreviewGateway = (options: TailnetPreviewGatewayOptions) =>
  Effect.tryPromise({
    try: async (): Promise<RunningTailnetPreviewGateway> => {
      const cookieName = `__Host-verne-preview-${options.target.port}`;
      const sockets = new Set<NodeNet.Socket>();
      const server = guardHttpResponseWriteErrors(NodeHttp.createServer());

      const validateRequest = async (request: NodeHttp.IncomingMessage) => {
        const sessionSecret = sessionSecretFromCookie(request.headers.cookie, cookieName);
        if (sessionSecret === undefined) return undefined;
        try {
          return await Effect.runPromise(
            options.auth.validateSession({
              environmentId: options.environmentId,
              port: options.target.port,
              leaseId: options.leaseId,
              sessionSecret,
            }),
          );
        } catch {
          return undefined;
        }
      };

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
      });

      server.on("request", (request, response) => {
        void (async () => {
          const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
          if (path === TAILNET_PREVIEW_AUTH_PATH && request.method === "GET") {
            response.writeHead(200, {
              "cache-control": "no-store",
              "content-security-policy": `default-src 'none'; script-src 'sha256-${bootstrapScriptHash}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
              "content-type": "text/html; charset=utf-8",
              "content-length": Buffer.byteLength(bootstrapDocument),
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
            });
            response.end(bootstrapDocument);
            return;
          }

          if (path === TAILNET_PREVIEW_AUTH_PATH && request.method === "POST") {
            let body: unknown;
            try {
              body = await readAuthenticationBody(request);
            } catch {
              endText(response, 400, "Invalid authentication request");
              return;
            }
            const launchSecret =
              typeof body === "object" && body !== null && "launchSecret" in body
                ? (body as { readonly launchSecret?: unknown }).launchSecret
                : undefined;
            const target =
              typeof body === "object" && body !== null && "target" in body
                ? (body as { readonly target?: unknown }).target
                : undefined;
            if (typeof launchSecret !== "string" || !isValidatedRelativeTarget(target)) {
              endText(response, 400, "Invalid authentication request");
              return;
            }
            try {
              const session = await Effect.runPromise(
                options.auth.exchangeLaunch({
                  environmentId: options.environmentId,
                  port: options.target.port,
                  leaseId: options.leaseId,
                  launchSecret,
                }),
              );
              const binding = await Effect.runPromise(
                options.auth.validateSession({
                  environmentId: options.environmentId,
                  port: options.target.port,
                  leaseId: options.leaseId,
                  sessionSecret: session.sessionSecret,
                }),
              );
              if (binding.target !== target) {
                endText(response, 401, "Invalid authentication request");
                return;
              }
              response.writeHead(303, {
                "cache-control": "no-store",
                location: target,
                "set-cookie": `${session.cookieName}=${session.sessionSecret}; HttpOnly; Secure; SameSite=Strict; Path=/`,
                "content-length": 0,
              });
              response.end();
            } catch {
              endText(response, 401, "Invalid authentication request", {
                "cache-control": "no-store",
              });
            }
            return;
          }

          if ((await validateRequest(request)) === undefined) {
            endText(response, 401, "Preview authentication required", {
              "cache-control": "no-store",
              location: TAILNET_PREVIEW_AUTH_PATH,
            });
            return;
          }

          const upstream = NodeHttp.request(
            {
              host: options.target.host,
              port: options.target.port,
              method: request.method,
              path: request.url,
              headers: filteredHeaders(request.headers, cookieName, options.target, false),
            },
            (upstreamResponse) => {
              if (response.destroyed) {
                upstreamResponse.destroy();
                return;
              }
              response.writeHead(
                upstreamResponse.statusCode ?? 502,
                upstreamResponse.statusMessage,
                filteredResponseHeaders(upstreamResponse.headers),
              );
              upstreamResponse.pipe(response);
            },
          );
          upstream.on("error", () => endText(response, 502, "Preview target unavailable"));
          request.on("aborted", () => upstream.destroy());
          response.on("close", () => {
            if (!response.writableEnded) upstream.destroy();
          });
          request.pipe(upstream);
        })().catch(() => endText(response, 502, "Preview gateway failure"));
      });

      server.on("upgrade", (request, socket, head) => {
        void (async () => {
          if ((await validateRequest(request)) === undefined) {
            writeSocketResponse(socket, 401, "Unauthorized");
            return;
          }
          const upstream = NodeNet.connect(options.target.port, options.target.host);
          let connected = false;
          upstream.on("connect", () => {
            connected = true;
            const headers = filteredHeaders(request.headers, cookieName, options.target, true);
            const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
            for (const [name, value] of Object.entries(headers)) {
              if (value === undefined) continue;
              if (Array.isArray(value)) {
                for (const entry of value) lines.push(`${name}: ${entry}`);
              } else {
                lines.push(`${name}: ${value}`);
              }
            }
            upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (head.length > 0) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          upstream.on("error", () => {
            if (!connected) writeSocketResponse(socket, 502, "Bad Gateway");
            else socket.destroy();
          });
          upstream.on("close", () => {
            if (!socket.destroyed) socket.end();
          });
          socket.on("close", () => upstream.destroy());
        })().catch(() => writeSocketResponse(socket, 502, "Bad Gateway"));
      });

      const gatewayPort = await listenLoopback(server);
      let closed = false;
      const close = Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            if (closed) {
              resolve();
              return;
            }
            closed = true;
            server.close((error) => (error === undefined ? resolve() : reject(error)));
            for (const socket of sockets) socket.destroy();
          }),
      );
      return { gatewayPort, target: options.target, close };
    },
    catch: (cause) => new TailnetPreviewGatewayStartError(cause),
  });
