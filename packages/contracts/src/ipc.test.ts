import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPortForwardEnsureInputSchema,
  DesktopPortForwardEnsureResultSchema,
} from "./ipc.ts";

describe("DesktopPortForward", () => {
  it("accepts a scoped tunnel bootstrap and loopback result", () => {
    expect(
      Schema.decodeUnknownSync(DesktopPortForwardEnsureInputSchema)({
        environmentId: "environment-1",
        leaseId: "lease-1",
        httpBaseUrl: "https://vps.example.com/",
        forwardTicket: "ticket",
        remotePort: 5173,
      }),
    ).toMatchObject({ remotePort: 5173 });
    expect(
      Schema.decodeUnknownSync(DesktopPortForwardEnsureResultSchema)({
        localPort: 5173,
        localUrl: "http://localhost:5173/",
      }),
    ).toEqual({ localPort: 5173, localUrl: "http://localhost:5173/" });
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
