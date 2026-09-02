// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeVM from "node:vm";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as TailnetPreviewAuth from "./TailnetPreviewAuth.ts";
import { startTailnetPreviewGateway } from "./TailnetPreviewGateway.ts";

const AUTH_PATH = "/.well-known/verne-preview/auth";
const environmentId = "env-preview";
const leaseId = "lease-preview";

interface HttpResult {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const closeActions: Array<() => Promise<void>> = [];

const closeServer = (server: NodeHttp.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const listen = (server: NodeHttp.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
      expect(address.address).toBe("127.0.0.1");
      resolve(address.port);
    });
  });

const startTarget = async (
  handler: NodeHttp.RequestListener,
  onUpgrade?: (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => void,
) => {
  const server = NodeHttp.createServer(handler);
  if (onUpgrade !== undefined) server.on("upgrade", onUpgrade);
  const port = await listen(server);
  closeActions.push(() => closeServer(server));
  return { server, port };
};

const request = (
  port: number,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: NodeHttp.OutgoingHttpHeaders;
    readonly body?: string;
  } = {},
) =>
  new Promise<HttpResult>((resolve, reject) => {
    const outgoing = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("aborted", () => reject(new Error("response aborted")));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.end(options.body);
    else outgoing.end();
  });

// These socket integration tests bridge Effect handles into Node event callbacks.
// eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
const runEffect = Effect.runPromise;

const makeAuth = () => runEffect(TailnetPreviewAuth.make.pipe(Effect.provide(NodeServices.layer)));

const startGateway = async (
  auth: TailnetPreviewAuth.TailnetPreviewAuth["Service"],
  targetPort: number,
) => {
  const gateway = await runEffect(
    startTailnetPreviewGateway({
      auth,
      environmentId,
      leaseId,
      target: { host: "127.0.0.1", port: targetPort },
    }),
  );
  closeActions.push(() => runEffect(gateway.close));
  return gateway;
};

const authenticate = async (
  auth: TailnetPreviewAuth.TailnetPreviewAuth["Service"],
  gatewayPort: number,
  targetPort: number,
  target = "/app?view=preview",
) => {
  const capability = await runEffect(
    auth.mintLaunch({ environmentId, port: targetPort, leaseId, target }),
  );
  const response = await request(gatewayPort, AUTH_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ launchSecret: capability.launchSecret, target }),
  });
  expect(response.status).toBe(303);
  const setCookie = response.headers["set-cookie"]?.[0];
  expect(setCookie).toContain(`__Host-verne-preview-${targetPort}=`);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");
  expect(response.headers.location).toBe(target);
  return setCookie!.split(";", 1)[0]!;
};

afterEach(async () => {
  for (const close of closeActions.splice(0).toReversed()) await close();
});

describe("TailnetPreviewGateway", () => {
  it("binds an ephemeral loopback port and closes idempotently", async () => {
    const target = await startTarget((_request, response) => response.end("ok"));
    const gateway = await startGateway(await makeAuth(), target.port);

    expect(gateway.gatewayPort).toBeGreaterThan(0);
    expect(gateway.target).toEqual({ host: "127.0.0.1", port: target.port });
    await runEffect(gateway.close);
    await runEffect(gateway.close);
    await expect(request(gateway.gatewayPort, "/")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("rejects unauthenticated app requests and serves a no-store fragment bootstrap", async () => {
    const target = await startTarget((_request, response) => response.end("should not reach"));
    const gateway = await startGateway(await makeAuth(), target.port);

    const denied = await request(gateway.gatewayPort, "/app");
    expect(denied.status).toBe(401);
    expect(denied.headers.location).toBe(AUTH_PATH);

    const bootstrap = await request(gateway.gatewayPort, AUTH_PATH);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers["cache-control"]).toBe("no-store");
    expect(bootstrap.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(bootstrap.body).toContain("location.hash");
    expect(bootstrap.body).toContain("history.replaceState");
  });

  it("executes its parser-time bootstrap and submits the capability without exposing it in a URL", async () => {
    const target = await startTarget((_request, response) => response.end("ok"));
    const gateway = await startGateway(await makeAuth(), target.port);
    const bootstrap = await request(gateway.gatewayPort, AUTH_PATH);
    const script = bootstrap.body.match(/<script>([\s\S]*)<\/script>/u)?.[1];
    expect(script).toBeDefined();
    const bodyStart = bootstrap.body.indexOf("<body");
    const scriptStart = bootstrap.body.indexOf("<script>");
    const bodyExistsWhenScriptRuns = bodyStart >= 0 && bodyStart < scriptStart;

    const appended: Array<{ name?: string; value?: string }> = [];
    let submitted:
      | { readonly action: string; readonly method: string; readonly fields: typeof appended }
      | undefined;
    const historyCalls: unknown[][] = [];
    const form = {
      action: "",
      method: "",
      append: (field: { name?: string; value?: string }) => appended.push(field),
      submit: () => {
        submitted = { action: form.action, method: form.method, fields: [...appended] };
      },
    };
    expect(() =>
      NodeVM.runInNewContext(script!, {
        decodeURIComponent,
        history: { replaceState: (...args: unknown[]) => historyCalls.push(args) },
        location: {
          hash: `#${encodeURIComponent(
            JSON.stringify({ launchSecret: "fragment-secret", target: "/app?q=1" }),
          )}`,
          pathname: AUTH_PATH,
          search: "",
        },
        document: {
          body: bodyExistsWhenScriptRuns ? { append: () => {} } : null,
          createElement: (tag: string) =>
            tag === "form" ? form : { name: "", type: "", value: "" },
        },
      }),
    ).not.toThrow();

    expect(historyCalls).toEqual([[null, "", AUTH_PATH]]);
    expect(submitted).toEqual({
      action: AUTH_PATH,
      method: "POST",
      fields: [
        { name: "launchSecret", type: "hidden", value: "fragment-secret" },
        { name: "target", type: "hidden", value: "/app?q=1" },
      ],
    });
  });

  it("consumes a launch once and redirects only to its validated relative target", async () => {
    const target = await startTarget((_request, response) => response.end("ok"));
    const auth = await makeAuth();
    const gateway = await startGateway(auth, target.port);
    const capability = await runEffect(
      auth.mintLaunch({ environmentId, port: target.port, leaseId, target: "/safe?x=1#part" }),
    );

    const exchange = () =>
      request(gateway.gatewayPort, AUTH_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          launchSecret: capability.launchSecret,
          target: "/safe?x=1#part",
        }),
      });
    expect((await exchange()).status).toBe(303);
    expect((await exchange()).status).toBe(401);

    const second = await runEffect(
      auth.mintLaunch({ environmentId, port: target.port, leaseId, target: "/safe" }),
    );
    const unsafe = await request(gateway.gatewayPort, AUTH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launchSecret: second.launchSecret, target: "https://evil.invalid/" }),
    });
    expect(unsafe.status).toBe(400);
    expect(unsafe.headers.location).toBeUndefined();
  });

  it("streams authenticated HTTP traffic with normalized and sanitized headers", async () => {
    const received = Promise.withResolvers<{
      method: string | undefined;
      url: string | undefined;
      headers: NodeHttp.IncomingHttpHeaders;
      body: string;
    }>();
    const target = await startTarget((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        received.resolve({
          method: incoming.method,
          url: incoming.url,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(207, {
          "content-type": "text/plain",
          connection: "close",
          "x-absolute-url": "https://target.invalid/not-rewritten",
          "x-verne-upstream-internal": "secret",
        });
        response.end("https://target.invalid/body-is-unchanged");
      });
    });
    const auth = await makeAuth();
    const gateway = await startGateway(auth, target.port);
    const cookie = await authenticate(auth, gateway.gatewayPort, target.port);

    const proxied = await request(gateway.gatewayPort, "/submit?q=hello", {
      method: "POST",
      headers: {
        cookie: `${cookie}; __Host-verne-preview-65535=foreign; unrelated=visible-upstream`,
        origin: "https://machine.tailnet.example:8443",
        connection: "keep-alive, x-remove-me",
        "x-remove-me": "secret",
        "x-verne-preview-internal": "secret",
        "content-type": "text/plain",
      },
      body: "streamed request",
    });

    expect(await received.promise).toEqual({
      method: "POST",
      url: "/submit?q=hello",
      headers: expect.objectContaining({
        host: `127.0.0.1:${target.port}`,
        origin: `http://127.0.0.1:${target.port}`,
        cookie: "unrelated=visible-upstream",
      }),
      body: "streamed request",
    });
    const upstreamHeaders = (await received.promise).headers;
    expect(upstreamHeaders["x-remove-me"]).toBeUndefined();
    expect(upstreamHeaders["x-verne-preview-internal"]).toBeUndefined();
    expect(proxied.status).toBe(207);
    expect(proxied.headers.connection).not.toBe("close");
    expect(proxied.headers["x-verne-upstream-internal"]).toBeUndefined();
    expect(proxied.headers["x-absolute-url"]).toBe("https://target.invalid/not-rewritten");
    expect(proxied.body).toBe("https://target.invalid/body-is-unchanged");
  });

  it("contains an upstream reset after partial response headers", async () => {
    const target = await startTarget((incoming, response) => {
      if (incoming.url === "/reset") {
        response.flushHeaders();
        response.write("partial", () => response.socket?.destroy());
        return;
      }
      response.end("healthy");
    });
    const auth = await makeAuth();
    const gateway = await startGateway(auth, target.port);
    const cookie = await authenticate(auth, gateway.gatewayPort, target.port);

    await expect(request(gateway.gatewayPort, "/reset", { headers: { cookie } })).rejects.toThrow(
      "response aborted",
    );
    await expect(
      request(gateway.gatewayPort, "/healthy", { headers: { cookie } }),
    ).resolves.toMatchObject({ status: 200, body: "healthy" });
  });

  it("rejects cookies issued for another port", async () => {
    const firstTarget = await startTarget((_request, response) => response.end("first"));
    const secondTarget = await startTarget((_request, response) => response.end("second"));
    const auth = await makeAuth();
    const firstGateway = await startGateway(auth, firstTarget.port);
    const secondGateway = await startGateway(auth, secondTarget.port);
    const firstCookie = await authenticate(auth, firstGateway.gatewayPort, firstTarget.port);

    const denied = await request(secondGateway.gatewayPort, "/", {
      headers: { cookie: firstCookie },
    });
    expect(denied.status).toBe(401);
  });

  it("rejects expired cookies", async () => {
    const target = await startTarget((_request, response) => response.end("target"));
    const harness = await runEffect(
      TailnetPreviewAuth.__testing
        .make({ sessionTtlMs: -1 })
        .pipe(Effect.provide(NodeServices.layer)),
    );
    const gateway = await startGateway(harness.auth, target.port);
    const capability = await runEffect(
      harness.auth.mintLaunch({
        environmentId,
        port: target.port,
        leaseId,
        target: "/expired",
      }),
    );
    const session = await runEffect(
      harness.auth.exchangeLaunch({
        environmentId,
        port: target.port,
        leaseId,
        launchSecret: capability.launchSecret,
      }),
    );

    const denied = await request(gateway.gatewayPort, "/expired", {
      headers: { cookie: `${session.cookieName}=${session.sessionSecret}` },
    });
    expect(denied.status).toBe(401);
  });

  it("rejects an unauthenticated WebSocket before connecting upstream", async () => {
    let targetUpgradeCount = 0;
    const target = await startTarget(
      (_request, response) => response.end("target"),
      (_request, socket) => {
        targetUpgradeCount += 1;
        socket.destroy();
      },
    );
    const gateway = await startGateway(await makeAuth(), target.port);

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new NodeSocket.NodeWS.WebSocket(
        `ws://127.0.0.1:${gateway.gatewayPort}/socket`,
      );
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.on("error", reject);
    });
    expect(status).toBe(401);
    expect(targetUpgradeCount).toBe(0);
  });

  it("proxies a real authenticated WebSocket bidirectionally", async () => {
    const webSocketServer = new NodeSocket.NodeWS.WebSocketServer({ noServer: true });
    const upstreamUpgrade = Promise.withResolvers<NodeHttp.IncomingMessage>();
    const downstreamUpgrade = Promise.withResolvers<NodeHttp.IncomingMessage>();
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (message) => socket.send(`echo:${String(message)}`));
    });
    webSocketServer.on("headers", (headers) => {
      const connectionIndex = headers.findIndex((header) =>
        header.toLowerCase().startsWith("connection:"),
      );
      headers[connectionIndex] = "Connection: Upgrade, x-response-remove";
      headers.push("x-response-remove: secret");
      headers.push("keep-alive: timeout=5");
      headers.push("x-verne-upstream-internal: secret");
    });
    const target = await startTarget(
      (_request, response) => response.end("http"),
      (request, socket, head) => {
        upstreamUpgrade.resolve(request);
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request);
        });
      },
    );
    closeActions.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of webSocketServer.clients) client.terminate();
          webSocketServer.close(() => resolve());
        }),
    );
    const auth = await makeAuth();
    const gateway = await startGateway(auth, target.port);
    const cookie = await authenticate(auth, gateway.gatewayPort, target.port);

    const message = await new Promise<string>((resolve, reject) => {
      const socket = new NodeSocket.NodeWS.WebSocket(
        `ws://127.0.0.1:${gateway.gatewayPort}/socket?q=1`,
        {
          headers: {
            cookie: `${cookie}; __Host-verne-preview-65535=foreign; app=visible-upstream`,
            origin: "https://machine.tailnet.example:8443",
            "keep-alive": "timeout=5",
            "proxy-authorization": "secret",
            "x-verne-preview-internal": "secret",
          },
        },
      );
      socket.on("upgrade", (response) => downstreamUpgrade.resolve(response));
      socket.on("open", () => socket.send("hello"));
      socket.on("message", (data) => {
        resolve(String(data));
        socket.close();
      });
      socket.on("error", reject);
    });
    expect(message).toBe("echo:hello");
    expect((await upstreamUpgrade.promise).headers).toEqual(
      expect.objectContaining({
        host: `127.0.0.1:${target.port}`,
        origin: `http://127.0.0.1:${target.port}`,
        connection: "Upgrade",
        upgrade: "websocket",
        cookie: "app=visible-upstream",
      }),
    );
    const upstreamHeaders = (await upstreamUpgrade.promise).headers;
    expect(upstreamHeaders["keep-alive"]).toBeUndefined();
    expect(upstreamHeaders["proxy-authorization"]).toBeUndefined();
    expect(upstreamHeaders["x-verne-preview-internal"]).toBeUndefined();

    const downstreamHeaders = (await downstreamUpgrade.promise).headers;
    expect(downstreamHeaders.connection).toBe("Upgrade");
    expect(downstreamHeaders.upgrade).toBe("websocket");
    expect(downstreamHeaders["x-response-remove"]).toBeUndefined();
    expect(downstreamHeaders["keep-alive"]).toBeUndefined();
    expect(downstreamHeaders["x-verne-upstream-internal"]).toBeUndefined();
  });

  it("removes a Connection-nominated header from a raw WebSocket handshake", async () => {
    const webSocketServer = new NodeSocket.NodeWS.WebSocketServer({ noServer: true });
    const upstreamUpgrade = Promise.withResolvers<NodeHttp.IncomingMessage>();
    const target = await startTarget(
      (_request, response) => response.end("http"),
      (request, socket, head) => {
        upstreamUpgrade.resolve(request);
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocket.terminate());
      },
    );
    closeActions.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of webSocketServer.clients) client.terminate();
          webSocketServer.close(() => resolve());
        }),
    );
    const auth = await makeAuth();
    const gateway = await startGateway(auth, target.port);
    const cookie = await authenticate(auth, gateway.gatewayPort, target.port);

    const responseStatus = await new Promise<string>((resolve, reject) => {
      const socket = NodeNet.connect(gateway.gatewayPort, "127.0.0.1", () => {
        socket.write(
          [
            "GET /raw-socket HTTP/1.1",
            "Host: machine.tailnet.example",
            "Connection: Upgrade, x-upgrade-remove",
            "Upgrade: websocket",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "x-upgrade-remove: secret",
            `Cookie: ${cookie}`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
        const boundary = received.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        resolve(received.slice(0, boundary).split("\r\n", 1)[0] ?? "");
        socket.destroy();
      });
      socket.on("error", reject);
    });

    expect(responseStatus).toBe("HTTP/1.1 101 Switching Protocols");
    expect((await upstreamUpgrade.promise).headers.connection).toBe("Upgrade");
    expect((await upstreamUpgrade.promise).headers["x-upgrade-remove"]).toBeUndefined();
  });

  it("shares close teardown and blocks a target connection after delayed auth", async () => {
    let targetConnections = 0;
    const target = await startTarget((_request, response) => response.end("unexpected"));
    target.server.on("connection", () => {
      targetConnections += 1;
    });
    const auth = await makeAuth();
    const capability = await runEffect(
      auth.mintLaunch({ environmentId, port: target.port, leaseId, target: "/race" }),
    );
    const session = await runEffect(
      auth.exchangeLaunch({
        environmentId,
        port: target.port,
        leaseId,
        launchSecret: capability.launchSecret,
      }),
    );
    const binding = await runEffect(
      auth.validateSession({
        environmentId,
        port: target.port,
        leaseId,
        sessionSecret: session.sessionSecret,
      }),
    );
    const validationStarted = Promise.withResolvers<void>();
    const releaseValidation = Promise.withResolvers<void>();
    const controlledAuth = TailnetPreviewAuth.TailnetPreviewAuth.of({
      ...auth,
      validateSession: () =>
        Effect.promise(async () => {
          validationStarted.resolve();
          await releaseValidation.promise;
          return binding;
        }),
    });
    const gateway = await startGateway(controlledAuth, target.port);

    const clientClosed = Promise.withResolvers<void>();
    const outgoing = NodeHttp.request({
      host: "127.0.0.1",
      port: gateway.gatewayPort,
      path: "/race",
      headers: { cookie: `${session.cookieName}=${session.sessionSecret}` },
    });
    outgoing.on("socket", (socket) => socket.on("close", () => clientClosed.resolve()));
    outgoing.on("error", () => {});
    outgoing.end();
    await validationStarted.promise;

    let firstCloseResolved = false;
    let secondCloseResolved = false;
    const firstClose = runEffect(gateway.close).then(() => {
      firstCloseResolved = true;
    });
    const secondClose = runEffect(gateway.close).then(() => {
      secondCloseResolved = true;
    });
    await clientClosed.promise;
    expect(firstCloseResolved).toBe(false);
    expect(secondCloseResolved).toBe(false);
    expect(targetConnections).toBe(0);

    releaseValidation.resolve();
    await Promise.all([firstClose, secondClose]);
    expect(targetConnections).toBe(0);
  });

  it("terminates an active outbound HTTP connection on close", async () => {
    const targetStarted = Promise.withResolvers<void>();
    const targetClosed = Promise.withResolvers<void>();
    let targetWasClosed = false;
    void targetClosed.promise.then(() => {
      targetWasClosed = true;
    });
    const target = await startTarget((incoming) => {
      targetStarted.resolve();
      incoming.socket.on("close", () => targetClosed.resolve());
    });
    const auth = await makeAuth();
    const gateway = await startGateway(auth, target.port);
    const cookie = await authenticate(auth, gateway.gatewayPort, target.port);
    void request(gateway.gatewayPort, "/held", { headers: { cookie } }).catch(() => {});
    await targetStarted.promise;

    await Promise.all([runEffect(gateway.close), runEffect(gateway.close)]);
    await targetClosed.promise;
    expect(targetWasClosed).toBe(true);
  });

  it("returns 502 when the target cannot be reached and remains healthy", async () => {
    const unavailable = NodeHttp.createServer();
    const unavailablePort = await listen(unavailable);
    await closeServer(unavailable);
    const auth = await makeAuth();
    const gateway = await startGateway(auth, unavailablePort);
    const cookie = await authenticate(auth, gateway.gatewayPort, unavailablePort);

    const failed = await request(gateway.gatewayPort, "/missing", { headers: { cookie } });
    expect(failed.status).toBe(502);
    const stillAlive = await request(gateway.gatewayPort, "/missing", { headers: { cookie } });
    expect(stillAlive.status).toBe(502);
  });
});
