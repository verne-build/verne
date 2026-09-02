import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));

describe("browser target resolver", () => {
  beforeEach(() => readPreparedConnection.mockReset());

  it.each([
    [
      "SSH",
      "http://127.0.0.1:43881",
      new SshConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "SSH",
        connectionId: "ssh-1",
      }),
    ],
    [
      "relay",
      "https://relay.example.com",
      new RelayConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Relay",
      }),
    ],
    [
      "LAN bearer",
      "http://192.168.1.25:3773",
      new BearerConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "LAN",
        connectionId: "lan-1",
      }),
    ],
    [
      "Tailnet bearer",
      "http://100.65.180.100:3773",
      new BearerConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Tailnet",
        connectionId: "tailnet-1",
      }),
    ],
  ])(
    "prepares an authenticated tunnel for every remote desktop %s target",
    async (_name, httpBaseUrl, target) => {
      readPreparedConnection.mockReturnValue({ httpBaseUrl, target });
      const { prepareBrowserNavigationTargetWith } = await import("./browserTargetResolver");
      const acquireLease = vi.fn(async () => ({
        leaseId: "lease-1",
        ticket: "ticket",
        port: 5173,
        connectHost: "127.0.0.1" as const,
        expiresAt: "2026-09-01T18:00:00.000Z",
      }));
      const ensureDesktopForward = vi.fn(async () => ({
        localPort: 45173,
        localUrl: "http://localhost:45173/",
      }));

      const resolved = await prepareBrowserNavigationTargetWith(
        EnvironmentId.make("environment-1"),
        { kind: "url", url: "http://localhost:5173/dashboard?mode=test#results" },
        { acquireLease, ensureDesktopForward },
      );

      expect(resolved).toEqual({
        requestedUrl: "http://localhost:5173/dashboard?mode=test#results",
        resolvedUrl: "http://localhost:45173/dashboard?mode=test#results",
        resolutionKind: "authenticated-tunnel",
        environmentId: "environment-1",
      });
      expect(acquireLease).toHaveBeenCalledWith(5173);
    },
  );

  it.each([
    [5173, "http://localhost:5173/app"],
    [45173, "http://localhost:45173/app"],
  ])(
    "uses the actual desktop listener port %i in the resolved URL",
    async (localPort, expectedUrl) => {
      readPreparedConnection.mockReturnValue({
        httpBaseUrl: "https://relay.example.com",
        target: new RelayConnectionTarget({
          environmentId: EnvironmentId.make("environment-1"),
          label: "Relay",
        }),
      });
      const { prepareBrowserNavigationTargetWith } = await import("./browserTargetResolver");
      const resolved = await prepareBrowserNavigationTargetWith(
        EnvironmentId.make("environment-1"),
        { kind: "url", url: "http://localhost:5173/app" },
        {
          acquireLease: async () => ({
            leaseId: "lease-1",
            ticket: "ticket",
            port: 5173,
            connectHost: "127.0.0.1",
            expiresAt: "2026-09-01T18:00:00.000Z",
          }),
          ensureDesktopForward: async () => ({
            localPort,
            localUrl: `http://localhost:${localPort}/`,
          }),
        },
      );

      expect(resolved.resolvedUrl).toBe(expectedUrl);
    },
  );

  it("keeps localhost navigation local for a local environment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "localhost:3000/app",
      resolvedUrl: "localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("keeps localhost navigation local for the full IPv4 loopback range", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.2:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:3000/app",
      resolvedUrl: "http://localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("refuses synchronous remote resolution until the authenticated access controller runs", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }),
    ).toThrow(/authenticated preview access controller/);
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:5173",
      }),
    ).toThrow(/authenticated preview access controller/);
  });

  it("prepares an authenticated desktop tunnel for a public paired environment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    const { prepareBrowserNavigationTargetWith } = await import("./browserTargetResolver");
    const resolved = await prepareBrowserNavigationTargetWith(
      EnvironmentId.make("environment-1"),
      { kind: "url", url: "http://localhost:5173/app?x=1#top" },
      {
        acquireLease: async () => ({
          leaseId: "lease-1",
          ticket: "ticket",
          port: 5173,
          connectHost: "127.0.0.1",
          expiresAt: "2026-09-01T18:00:00.000Z",
        }),
        ensureDesktopForward: async () => ({
          localPort: 45173,
          localUrl: "http://localhost:45173/",
        }),
      },
    );
    expect(resolved).toEqual({
      requestedUrl: "http://localhost:5173/app?x=1#top",
      resolvedUrl: "http://localhost:45173/app?x=1#top",
      resolutionKind: "authenticated-tunnel",
      environmentId: "environment-1",
    });
  });

  it("rejects plaintext public preview tunnels", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://preview.example.com" });
    const { prepareBrowserNavigationTargetWith } = await import("./browserTargetResolver");

    await expect(
      prepareBrowserNavigationTargetWith(
        EnvironmentId.make("environment-1"),
        { kind: "url", url: "http://localhost:5173" },
        {
          acquireLease: async () => {
            throw new Error("must not acquire");
          },
          ensureDesktopForward: async () => {
            throw new Error("must not connect");
          },
        },
      ),
    ).rejects.toThrow(/HTTPS\/WSS/);
  });

  it("prepares a tunnel for an SSH environment whose server bridge is local", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://127.0.0.1:43881",
      target: { _tag: "SshConnectionTarget" },
    });
    const { prepareBrowserNavigationTargetWith } = await import("./browserTargetResolver");
    const acquireLease = vi.fn(async () => ({
      leaseId: "lease-ssh",
      ticket: "ticket",
      port: 5173,
      connectHost: "127.0.0.1" as const,
      expiresAt: "2026-09-01T18:00:00.000Z",
    }));
    const resolved = await prepareBrowserNavigationTargetWith(
      EnvironmentId.make("environment-1"),
      { kind: "url", url: "http://localhost:5173/app" },
      {
        acquireLease,
        ensureDesktopForward: async () => ({
          localPort: 45173,
          localUrl: "http://localhost:45173/",
        }),
      },
    );

    expect(acquireLease).toHaveBeenCalledWith(5173);
    expect(resolved.resolvedUrl).toBe("http://localhost:45173/app");
    expect(resolved.resolutionKind).toBe("authenticated-tunnel");
  });

  it("normalizes schemeless localhost server-picker values", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://localhost:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "0.0.0.0:3000/app"),
    ).toBe("http://localhost:3000/app");
  });

  it("preserves localhost server-picker values when the prepared base is 127.0.0.1", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173/app?x=1#top"),
    ).toBe("http://localhost:5173/app?x=1#top");
  });

  it("normalizes public URLs without treating them as environment ports", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "example.com/app")).toBe(
      "https://example.com/app",
    );
  });

  it("does not rewrite localhost directly onto a private IPv6 control host", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://[fd7a:115c:a1e0::53]:3773",
      target: new BearerConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Tailnet IPv6",
        connectionId: "tailnet-ipv6",
      }),
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app?mode=test",
      }),
    ).toThrow(/authenticated preview access controller/);
  });

  it("supports a local IPv6 environment host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://[::1]:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }).resolvedUrl,
    ).toBe("http://localhost:5173/");
  });

  it("maps local IPv4 environment ports onto localhost for dual-stack guests", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app",
      }).resolvedUrl,
    ).toBe("http://localhost:5173/app");
  });

  it("leaves malformed input for the normal navigation error path", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "   ")).toBe("   ");
  });

  it("classifies exact private IPv4 and IPv6 boundaries", async () => {
    const { isPrivateNetworkHost } = await import("./browserTargetResolver");
    const privateHosts = [
      "0.0.0.0",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.0",
      "127.255.255.255",
      "169.254.0.0",
      "169.254.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.0.0",
      "192.168.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "fc00::",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::",
      "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.168.1.1",
      "localhost.",
      "localhost..",
      "devbox.",
      "devbox..",
      "printer.local.",
      "printer.local..",
      "printer.home.arpa.",
      "printer.home.arpa..",
      "devbox.example.ts.net.",
      "devbox.example.ts.net..",
    ];
    const publicHosts = [
      "1.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "fbff:ffff::",
      "fec0::",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "example.com.",
    ];
    expect(privateHosts.filter((host) => !isPrivateNetworkHost(host))).toEqual([]);
    expect(publicHosts.filter(isPrivateNetworkHost)).toEqual([]);
  });

  it("allows only globally routable hosts to reach a public favicon provider", async () => {
    const { isPublicFaviconHost } = await import("./browserTargetResolver");
    const nonPublic = [
      "192.0.0.0",
      "192.0.0.255",
      "192.0.2.0",
      "192.0.2.255",
      "192.88.99.0",
      "192.88.99.255",
      "198.51.100.0",
      "198.51.100.255",
      "203.0.113.0",
      "203.0.113.255",
      "224.0.0.0",
      "255.255.255.255",
      "::2",
      "100::",
      "100::ffff:ffff:ffff:ffff",
      "100:0:0:1::",
      "100:0:0:1:ffff:ffff:ffff:ffff",
      "64:ff9b:1::1",
      "64:ff9b::a00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::c0a8:101",
      "64:ff9b::c000:201",
      "2001:5::1",
      "2001:2::",
      "2001:2:0:ffff:ffff:ffff:ffff:ffff",
      "2001:db8::",
      "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
      "3fff::",
      "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
      "5f00::1",
      "fec0::",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.0.2.1",
      "app.test",
      "app.test..",
      "printer.local..",
      "printer.home.arpa..",
      "devbox.example.ts.net..",
      "127.0.0.1..",
      "127.1..",
      "10.1..",
      "172.16.1..",
      "192.168.1..",
      "service.internal",
      "hidden.onion",
    ];
    const publicHosts = [
      "191.255.255.255",
      "192.0.1.255",
      "192.0.3.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
      "1.1.1.1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "64:ff9b::808:808",
      "2001:1::1",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
      "::ffff:8.8.8.8",
      "example.com",
      "example.com.",
    ];
    expect(nonPublic.filter(isPublicFaviconHost)).toEqual([]);
    expect(publicHosts.filter((host) => !isPublicFaviconHost(host))).toEqual([]);
  });
});
