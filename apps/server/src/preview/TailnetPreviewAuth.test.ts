import * as NodeCrypto from "node:crypto";
import { it as effectIt } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as TailnetPreviewAuth from "./TailnetPreviewAuth.ts";

const sha256Hex = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const makeTestCrypto = () => {
  let nextByte = 0;
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill((nextByte += 1)),
      digest: (_algorithm, data) =>
        Effect.succeed(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
    }),
  );
};

const makeHarness = (options?: Partial<TailnetPreviewAuth.TailnetPreviewAuthOptions>) =>
  TailnetPreviewAuth.__testing.make(options).pipe(Effect.provide(makeTestCrypto()));

effectIt.effect("mints a fragment-safe launch capability and retains only its digest", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const capability = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/preview?tab=app#main",
    });

    expect(capability.launchSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(capability.expiresAt).toMatch(/Z$/);

    const state = yield* harness.inspectState;
    expect(state.launches).toHaveLength(1);
    expect(state.launches[0]).toMatchObject({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/preview?tab=app#main",
      secretDigest: sha256Hex(capability.launchSecret),
    });
    expect(state.launches[0]?.secretDigest).not.toBe(capability.launchSecret);
    expect(state.launches[0]).not.toHaveProperty("launchSecret");
  }),
);

effectIt.effect("binds launches and sessions to environment, port, lease, and target", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const capability = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/editor/file.ts?line=10#focus",
    });

    const session = yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      launchSecret: capability.launchSecret,
    });
    expect(session.cookieName).toBe("__Host-verne-preview-3000");
    expect(session.sessionSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.expiresAt).toMatch(/Z$/);

    const state = yield* harness.inspectState;
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/editor/file.ts?line=10#focus",
      cookieName: "__Host-verne-preview-3000",
      secretDigest: sha256Hex(session.sessionSecret),
    });
    expect(state.sessions[0]?.secretDigest).not.toBe(session.sessionSecret);
    expect(state.sessions[0]).not.toHaveProperty("sessionSecret");

    const binding = yield* harness.auth.validateSession({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      sessionSecret: session.sessionSecret,
    });
    expect(binding).toEqual({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/editor/file.ts?line=10#focus",
      cookieName: "__Host-verne-preview-3000",
    });

    const replay = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        launchSecret: capability.launchSecret,
      }),
    );
    expect(replay).toMatchObject({ _tag: "TailnetPreviewLaunchInvalidError", reason: "replayed" });
  }),
);

effectIt.effect("rejects wrong-port exchange and wrong-port session validation", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const capability = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/",
    });

    const wrongExchange = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 5173,
        leaseId: "lease-1",
        launchSecret: capability.launchSecret,
      }),
    );
    expect(wrongExchange).toMatchObject({
      _tag: "TailnetPreviewLaunchInvalidError",
      reason: "binding-mismatch",
    });

    const session3000 = yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      launchSecret: capability.launchSecret,
    });
    const wrongSession = yield* Effect.flip(
      harness.auth.validateSession({
        environmentId: "env-1",
        port: 5173,
        leaseId: "lease-1",
        sessionSecret: session3000.sessionSecret,
      }),
    );
    expect(wrongSession).toMatchObject({
      _tag: "TailnetPreviewSessionInvalidError",
      reason: "binding-mismatch",
    });
  }),
);

effectIt.effect("expires unconsumed launches after sixty seconds", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const capability = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/",
    });

    yield* TestClock.adjust(Duration.seconds(61));

    const expired = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        launchSecret: capability.launchSecret,
      }),
    );
    expect(expired).toMatchObject({
      _tag: "TailnetPreviewLaunchInvalidError",
      reason: "expired",
    });
  }),
);

effectIt.effect(
  "uses distinct host-only cookie names per port and never cross-authorizes sessions",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const capability3000 = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-3000",
        target: "/",
      });
      const capability5173 = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 5173,
        leaseId: "lease-5173",
        target: "/dashboard",
      });

      const session3000 = yield* harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-3000",
        launchSecret: capability3000.launchSecret,
      });
      const session5173 = yield* harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 5173,
        leaseId: "lease-5173",
        launchSecret: capability5173.launchSecret,
      });

      expect(session3000.cookieName).toBe("__Host-verne-preview-3000");
      expect(session5173.cookieName).toBe("__Host-verne-preview-5173");
      expect(session3000.cookieName).not.toBe(session5173.cookieName);

      const wrongPort = yield* Effect.flip(
        harness.auth.validateSession({
          environmentId: "env-1",
          port: 5173,
          leaseId: "lease-3000",
          sessionSecret: session3000.sessionSecret,
        }),
      );
      expect(wrongPort).toMatchObject({
        _tag: "TailnetPreviewSessionInvalidError",
        reason: "binding-mismatch",
      });
    }),
);

effectIt.effect("revokes unconsumed launches and established sessions by lease", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const consumedLaunch = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/consumed",
    });
    const pendingLaunch = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/pending",
    });

    const session = yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      launchSecret: consumedLaunch.launchSecret,
    });

    yield* harness.auth.revokeLease("lease-1");

    const revokedLaunch = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        launchSecret: pendingLaunch.launchSecret,
      }),
    );
    expect(revokedLaunch).toMatchObject({
      _tag: "TailnetPreviewLaunchInvalidError",
      reason: "revoked",
    });

    const revokedSession = yield* Effect.flip(
      harness.auth.validateSession({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        sessionSecret: session.sessionSecret,
      }),
    );
    expect(revokedSession).toMatchObject({
      _tag: "TailnetPreviewSessionInvalidError",
      reason: "revoked",
    });
  }),
);

effectIt.effect("rejects malformed targets before state changes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ maxActiveLaunches: 1 });

    const networkPath = yield* Effect.flip(
      harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        target: "//evil.example/path",
      }),
    );
    expect(networkPath).toMatchObject({
      _tag: "TailnetPreviewTargetInvalidError",
      reason: "network-path",
    });

    const absolute = yield* Effect.flip(
      harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        target: "https://evil.example/path",
      }),
    );
    expect(absolute).toMatchObject({
      _tag: "TailnetPreviewTargetInvalidError",
      reason: "absolute-url",
    });

    const control = yield* Effect.flip(
      harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        target: "/bad\npath",
      }),
    );
    expect(control).toMatchObject({
      _tag: "TailnetPreviewTargetInvalidError",
      reason: "control-character",
    });

    const valid = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/still-valid",
    });
    expect(valid.launchSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }),
);

effectIt.effect("evicts expired launches and sessions before enforcing bounded capacity", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      maxActiveLaunches: 1,
      maxActiveSessions: 1,
      sessionTtlMs: 5_000,
    });

    yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/one",
    });
    const launchCapacity = yield* Effect.flip(
      harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-2",
        target: "/two",
      }),
    );
    expect(launchCapacity).toMatchObject({
      _tag: "TailnetPreviewAuthCapacityError",
      resource: "launch",
    });

    yield* TestClock.adjust(Duration.seconds(61));

    const secondLaunch = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-2",
      target: "/two",
    });
    yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-2",
      launchSecret: secondLaunch.launchSecret,
    });

    const thirdLaunch = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-3",
      target: "/three",
    });
    const sessionCapacity = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-3",
        launchSecret: thirdLaunch.launchSecret,
      }),
    );
    expect(sessionCapacity).toMatchObject({
      _tag: "TailnetPreviewAuthCapacityError",
      resource: "session",
    });

    yield* TestClock.adjust(Duration.seconds(6));

    const session = yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-3",
      launchSecret: thirdLaunch.launchSecret,
    });
    expect(session.cookieName).toBe("__Host-verne-preview-3000");
  }),
);

effectIt.effect("bounds replay tombstones and leaves evicted replays invalid as unknown", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      maxUsedLaunchTombstones: 2,
    });

    const first = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      target: "/first",
    });
    yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-1",
      launchSecret: first.launchSecret,
    });

    const second = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-2",
      target: "/second",
    });
    yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-2",
      launchSecret: second.launchSecret,
    });

    const third = yield* harness.auth.mintLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-3",
      target: "/third",
    });
    yield* harness.auth.exchangeLaunch({
      environmentId: "env-1",
      port: 3000,
      leaseId: "lease-3",
      launchSecret: third.launchSecret,
    });

    const state = yield* harness.inspectState;
    expect(state.usedLaunches).toHaveLength(2);

    const firstReplay = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        launchSecret: first.launchSecret,
      }),
    );
    expect(firstReplay).toMatchObject({
      _tag: "TailnetPreviewLaunchInvalidError",
      reason: "unknown",
    });

    const secondReplay = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-2",
        launchSecret: second.launchSecret,
      }),
    );
    expect(secondReplay).toMatchObject({
      _tag: "TailnetPreviewLaunchInvalidError",
      reason: "replayed",
    });

    const thirdReplay = yield* Effect.flip(
      harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-3",
        launchSecret: third.launchSecret,
      }),
    );
    expect(thirdReplay).toMatchObject({
      _tag: "TailnetPreviewLaunchInvalidError",
      reason: "replayed",
    });
  }),
);

effectIt.effect(
  "bounds revoked-launch tombstones and leaves evicted revoked launches invalid",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        maxRevokedLaunchTombstones: 2,
      });

      const first = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        target: "/first",
      });
      yield* harness.auth.revokeLease("lease-1");

      const second = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-2",
        target: "/second",
      });
      yield* harness.auth.revokeLease("lease-2");

      const third = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-3",
        target: "/third",
      });
      yield* harness.auth.revokeLease("lease-3");

      const state = yield* harness.inspectState;
      expect(state.revokedLaunches).toHaveLength(2);

      const firstRevoked = yield* Effect.flip(
        harness.auth.exchangeLaunch({
          environmentId: "env-1",
          port: 3000,
          leaseId: "lease-1",
          launchSecret: first.launchSecret,
        }),
      );
      expect(firstRevoked).toMatchObject({
        _tag: "TailnetPreviewLaunchInvalidError",
        reason: "unknown",
      });

      const secondRevoked = yield* Effect.flip(
        harness.auth.exchangeLaunch({
          environmentId: "env-1",
          port: 3000,
          leaseId: "lease-2",
          launchSecret: second.launchSecret,
        }),
      );
      expect(secondRevoked).toMatchObject({
        _tag: "TailnetPreviewLaunchInvalidError",
        reason: "revoked",
      });

      const thirdRevoked = yield* Effect.flip(
        harness.auth.exchangeLaunch({
          environmentId: "env-1",
          port: 3000,
          leaseId: "lease-3",
          launchSecret: third.launchSecret,
        }),
      );
      expect(thirdRevoked).toMatchObject({
        _tag: "TailnetPreviewLaunchInvalidError",
        reason: "revoked",
      });
    }),
);

effectIt.effect(
  "bounds revoked-session tombstones and leaves evicted revoked sessions invalid",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        maxRevokedSessionTombstones: 2,
      });

      const firstLaunch = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        target: "/first",
      });
      const firstSession = yield* harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-1",
        launchSecret: firstLaunch.launchSecret,
      });
      yield* harness.auth.revokeLease("lease-1");

      const secondLaunch = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-2",
        target: "/second",
      });
      const secondSession = yield* harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-2",
        launchSecret: secondLaunch.launchSecret,
      });
      yield* harness.auth.revokeLease("lease-2");

      const thirdLaunch = yield* harness.auth.mintLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-3",
        target: "/third",
      });
      const thirdSession = yield* harness.auth.exchangeLaunch({
        environmentId: "env-1",
        port: 3000,
        leaseId: "lease-3",
        launchSecret: thirdLaunch.launchSecret,
      });
      yield* harness.auth.revokeLease("lease-3");

      const state = yield* harness.inspectState;
      expect(state.revokedSessions).toHaveLength(2);

      const firstRevoked = yield* Effect.flip(
        harness.auth.validateSession({
          environmentId: "env-1",
          port: 3000,
          leaseId: "lease-1",
          sessionSecret: firstSession.sessionSecret,
        }),
      );
      expect(firstRevoked).toMatchObject({
        _tag: "TailnetPreviewSessionInvalidError",
        reason: "unknown",
      });

      const secondRevoked = yield* Effect.flip(
        harness.auth.validateSession({
          environmentId: "env-1",
          port: 3000,
          leaseId: "lease-2",
          sessionSecret: secondSession.sessionSecret,
        }),
      );
      expect(secondRevoked).toMatchObject({
        _tag: "TailnetPreviewSessionInvalidError",
        reason: "revoked",
      });

      const thirdRevoked = yield* Effect.flip(
        harness.auth.validateSession({
          environmentId: "env-1",
          port: 3000,
          leaseId: "lease-3",
          sessionSecret: thirdSession.sessionSecret,
        }),
      );
      expect(thirdRevoked).toMatchObject({
        _tag: "TailnetPreviewSessionInvalidError",
        reason: "revoked",
      });
    }),
);
