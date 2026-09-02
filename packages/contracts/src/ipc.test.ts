import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPortForwardEnsureInputSchema,
  DesktopPortForwardEnsureResultSchema,
  DesktopPortForwardReleaseInputSchema,
} from "./ipc.ts";

const decodeDesktopPortForwardEnsureInput = Schema.decodeUnknownSync(
  DesktopPortForwardEnsureInputSchema,
);
const decodeDesktopPortForwardEnsureResult = Schema.decodeUnknownSync(
  DesktopPortForwardEnsureResultSchema,
);
const decodeDesktopPortForwardReleaseInput = Schema.decodeUnknownSync(
  DesktopPortForwardReleaseInputSchema,
);

describe("DesktopPortForward", () => {
  it("accepts a scoped tunnel bootstrap and loopback result", () => {
    expect(
      decodeDesktopPortForwardEnsureInput({
        environmentId: "environment-1",
        leaseId: "lease-1",
        httpBaseUrl: "https://vps.example.com/",
        forwardTicket: "ticket",
        remotePort: 5173,
      }),
    ).toMatchObject({ remotePort: 5173 });
    expect(
      decodeDesktopPortForwardEnsureResult({
        localPort: 5173,
        localUrl: "http://localhost:5173/",
      }),
    ).toEqual({ localPort: 5173, localUrl: "http://localhost:5173/" });
    expect(
      decodeDesktopPortForwardReleaseInput({
        environmentId: "environment-1",
        leaseId: "lease-1",
        remotePort: 5173,
      }),
    ).toEqual({ environmentId: "environment-1", leaseId: "lease-1", remotePort: 5173 });
  });

  it("rejects unbounded tunnel endpoint and opaque credential fields", () => {
    const base = {
      environmentId: "environment-1",
      leaseId: "lease-1",
      httpBaseUrl: "https://vps.example.com/",
      forwardTicket: "ticket",
      remotePort: 5173,
    };
    expect(() =>
      decodeDesktopPortForwardEnsureInput({ ...base, httpBaseUrl: `https://${"a".repeat(2_048)}` }),
    ).toThrow();
    expect(() =>
      decodeDesktopPortForwardEnsureInput({ ...base, leaseId: "a".repeat(257) }),
    ).toThrow();
    expect(() =>
      decodeDesktopPortForwardEnsureInput({ ...base, forwardTicket: "a".repeat(257) }),
    ).toThrow();
    expect(() =>
      decodeDesktopPortForwardReleaseInput({
        environmentId: "environment-1",
        leaseId: "a".repeat(257),
        remotePort: 5173,
      }),
    ).toThrow();
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});
