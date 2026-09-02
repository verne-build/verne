// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import * as NodeVM from "node:vm";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as TailnetPreviewAuth from "./TailnetPreviewAuth.ts";
import {
  formatTailnetPreviewTargetAuthority,
  startTailnetPreviewGateway,
} from "./TailnetPreviewGateway.ts";

const AUTH_PATH = "/.well-known/verne-preview/auth";
const environmentId = "env-preview";
const leaseId = "lease-preview";

const trustedCertificate = `-----BEGIN CERTIFICATE-----
MIIDODCCAiCgAwIBAgIUBlbm07HDUIqgJvxWcPB1bDqrgLMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkwMjA5MzczMVoXDTM2MDgz
MDA5MzczMVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAw8waJfUjPH952831lLiTeudOF9yCNv8Xx3xbblTjCkbZ
JqZXnjt8oE+JlXldBVFnKIuC0QQpADM6vmJh5qCqgiBEMKvJX3yviXV2FsK9g/ue
YgcZBCCYUDX1diiZuX/65udeUhta0jCIXZ9JuY3ALSnHBfWVE3kdj5L8NW2qphBw
sbX8sAOkeq8CePhtJ9threR/A2waR8ALmWKlxKDf2xh7G6cTA8lfDlE6pYPX/plH
bQ6dKk5LGpsY8Ub2QPQWD9D/PnJaas6tCjwsq+bn+gbNcecTg8PswIpFbv7q2VTG
XEMQU7kwcU7Mhh2h71QEERFhj9QkGFz7FoVlkUwKmQIDAQABo4GBMH8wHQYDVR0O
BBYEFMfseT8S1Nmv5jPHW/GNZQQOyneuMB8GA1UdIwQYMBaAFMfseT8S1Nmv5jPH
W/GNZQQOyneuMA8GA1UdEwEB/wQFMAMBAf8wLAYDVR0RBCUwI4IJbG9jYWxob3N0
hwR/AAABhxAAAAAAAAAAAAAAAAAAAAABMA0GCSqGSIb3DQEBCwUAA4IBAQDBOTN+
jLziYB8K1bpNz5Bq3aoCsibBba9Rxb5EZVy/BBnbN/pP2wX4Az4p3KuMxZBl+cL/
eQG/y/wOWp+FAUab00zBo9Bkw3I8Q4K9PzpsCVOc38CC5iemMQDw1GYsfVFImZMT
jKEj0sDJGtEhN4tIJc5h7FD6FdsrzCy8EXvarxXELt3Bbh7hFjN9LcyehH/8SdPa
cy5KYdGrrTqS38OKBaJrlfO5TK9w6XsagNXwG5CHP/wuqeYiG8B+k8f1tf36mamo
qMkczA00600frgI4yDL0zqn14SuycoU0SSjfdWjt6fSoKULWWiqCJhne16QF6oJu
cF1w9FNoRsidEBPQ
-----END CERTIFICATE-----`;
const trustedPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDDzBol9SM8f3nb
zfWUuJN6504X3II2/xfHfFtuVOMKRtkmpleeO3ygT4mVeV0FUWcoi4LRBCkAMzq+
YmHmoKqCIEQwq8lffK+JdXYWwr2D+55iBxkEIJhQNfV2KJm5f/rm515SG1rSMIhd
n0m5jcAtKccF9ZUTeR2Pkvw1baqmEHCxtfywA6R6rwJ4+G0n22Gt5H8DbBpHwAuZ
YqXEoN/bGHsbpxMDyV8OUTqlg9f+mUdtDp0qTksamxjxRvZA9BYP0P8+clpqzq0K
PCyr5uf6Bs1x5xODw+zAikVu/urZVMZcQxBTuTBxTsyGHaHvVAQREWGP1CQYXPsW
hWWRTAqZAgMBAAECggEAEEmFBtGLnPOXM9BADJ8mgH+nfL9mcxP4+sqG0gicas1O
MMN/UB2vbifzoFQcR24YNFSXnRK5JOe+DBqDvZMxn9m2hmxx18A322nCmR3ZtTYL
/KhNvczG0sxMRwgVUouZd9X5AAA/x7KLE2ulzrpCiVc7c6zUOe6WJYxy77BX1NCt
hhcxAKfCfsoLdD6/lPZRyMHnxjp3hVSJ5UcQsK4IwD91KRT8scaZuThVMvHyHNo3
wcxVKdBLGFTNIcn5hkor1gj/GHUuiG3zIecexOoDc0u5ZCUb6PRZDhRYtjpKsCoz
cBmfaCYDIuHKOIng1y03L4H2HCPU2qnhn/N304CoIQKBgQD8MqDymnYJzkUnZx9H
hoLwX6WylEgATrQxTB4kUB8FZhW7TaVD7kNZAx8RHoVf/8Ry39s/mv6MgWn+vYDi
TAltiINKHGc+vlniqGSC/pmrZkbG9oIjY+s/Njz7QCfHKNxHUtk5pkDjN4h7x1vV
YNmFutt4Lr4WqrwRAhQ/1UGYYQKBgQDGv8rnusIjRf1Du3/sGiOYzMudIoLVl9zp
uv5o8WmAtMhESlKcid3uDm71qo7qiWDp/MOPJB57xsmYii8e/0SE6Z51UAy3hIrV
q7/DvL/f31nVu8e8bQ64hSui309nbdF+zjIpwgYgWZ8xtTDBgEnc3AwN63++mNA9
p/ytZ6I9OQKBgEcGly9b8uxWDEHJmBSTvGKn/Ulq21BC2hqcHk0Jx4LEulAS0P1t
p8f0yhYPK27a4F+dzeh+5Tt64vgcNKUG1wzjCl6f2y/fef8Mf6oou+x6lGpKWGJR
LJqT0t7LtagwSMFJguXqfZHAPQ7nGWThrsEr281gFKbblLWRiVRk4eFhAoGBAL5K
i99rNM3JCUB8mXJZZJO8IYeFr3cKO/2diFC6M6WDcevQrWArsE1pjFuyvbtZZW0j
EapPjtA7+HEQfSVUiyom9AymZEahpLwIAUdLxPp4Qu8dJ5QFZv7MoocDAGerAdZD
XkwU9QCsTnutW80pI49PMEtzm4/FiDxARvFQNEohAoGAWwtuI3g0l02U72VaZTnp
SHqiY/cTvRjioRbvRWs38MuxPlzKGZDb+W2DR/MMWjMe0QHBaoNgF6blRHIBJOQ1
87KLHMRoG3IwYd0QiuY8rEjW2z/iKMX1F99CSE/msSzm9ugXDdSblfaoYk3Xqxx8
Ga2coUU1vzVdb0k0BgtUDo4=
-----END PRIVATE KEY-----`;

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

const listenOn = (server: NodeHttp.Server, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
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

const trustTestCertificate = () => {
  const previous = NodeTls.getCACertificates("default");
  NodeTls.setDefaultCACertificates([...previous, trustedCertificate]);
  closeActions.push(async () => NodeTls.setDefaultCACertificates(previous));
};

const startSecureTarget = async (
  handler: NodeHttp.RequestListener,
  onUpgrade?: (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => void,
) => {
  trustTestCertificate();
  const server = NodeHttps.createServer(
    { cert: trustedCertificate, key: trustedPrivateKey },
    handler,
  );
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
  target: { readonly host?: string; readonly protocol?: "http:" | "https:" } = {},
) => {
  const gateway = await runEffect(
    startTailnetPreviewGateway({
      auth,
      environmentId,
      leaseId,
      target: {
        host: target.host ?? "127.0.0.1",
        port: targetPort,
        protocol: target.protocol ?? "http:",
      },
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
    expect(gateway.target).toEqual({ host: "127.0.0.1", port: target.port, protocol: "http:" });
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

  it("proxies HTTP requests to a trusted HTTPS target", async () => {
    const received = Promise.withResolvers<NodeHttp.IncomingMessage>();
    const target = await startSecureTarget((incoming, response) => {
      received.resolve(incoming);
      response.end("secure target");
    });
    const auth = await makeAuth();
    const gateway = await startGateway(auth, target.port, { protocol: "https:" });
    const cookie = await authenticate(auth, gateway.gatewayPort, target.port);

    const proxied = await request(gateway.gatewayPort, "/secure", {
      headers: { cookie, origin: "https://machine.tailnet.example" },
    });

    expect(proxied).toMatchObject({ status: 200, body: "secure target" });
    expect((await received.promise).headers).toEqual(
      expect.objectContaining({
        host: `127.0.0.1:${target.port}`,
        origin: `https://127.0.0.1:${target.port}`,
      }),
    );
  });

  it("formats IPv6 target authorities and proxies their Host and Origin when available", async () => {
    expect(formatTailnetPreviewTargetAuthority({ host: "::1", port: 43123 })).toBe("[::1]:43123");

    const received = Promise.withResolvers<NodeHttp.IncomingMessage>();
    const server = NodeHttp.createServer((incoming, response) => {
      received.resolve(incoming);
      response.end("ipv6 target");
    });
    let port: number;
    try {
      port = await listenOn(server, "::1");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAFNOSUPPORT") return;
      throw error;
    }
    closeActions.push(() => closeServer(server));
    const auth = await makeAuth();
    const gateway = await startGateway(auth, port, { host: "::1" });
    const cookie = await authenticate(auth, gateway.gatewayPort, port);

    const proxied = await request(gateway.gatewayPort, "/ipv6", {
      headers: { cookie, origin: "https://machine.tailnet.example" },
    });

    expect(proxied).toMatchObject({ status: 200, body: "ipv6 target" });
    expect((await received.promise).headers).toEqual(
      expect.objectContaining({ host: `[::1]:${port}`, origin: `http://[::1]:${port}` }),
    );
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

  it("proxies a real authenticated WebSocket to a trusted HTTPS target", async () => {
    const webSocketServer = new NodeSocket.NodeWS.WebSocketServer({ noServer: true });
    const upstreamUpgrade = Promise.withResolvers<NodeHttp.IncomingMessage>();
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (message) => socket.send(`secure-echo:${String(message)}`));
    });
    const target = await startSecureTarget(
      (_request, response) => response.end("https"),
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
    const gateway = await startGateway(auth, target.port, { protocol: "https:" });
    const cookie = await authenticate(auth, gateway.gatewayPort, target.port);

    const message = await new Promise<string>((resolve, reject) => {
      const socket = new NodeSocket.NodeWS.WebSocket(
        `ws://127.0.0.1:${gateway.gatewayPort}/secure-socket`,
        { headers: { cookie, origin: "https://machine.tailnet.example" } },
      );
      socket.on("open", () => socket.send("hello"));
      socket.on("message", (data) => {
        resolve(String(data));
        socket.close();
      });
      socket.on("error", reject);
    });

    expect(message).toBe("secure-echo:hello");
    expect((await upstreamUpgrade.promise).headers).toEqual(
      expect.objectContaining({
        host: `127.0.0.1:${target.port}`,
        origin: `https://127.0.0.1:${target.port}`,
      }),
    );
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
