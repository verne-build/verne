import { describe, expect, it, vi } from "vitest";
import { daemonVerdict, isUnknownMethodError, parseStamp } from "./daemon-staleness";
import { refreshInventoryAfterDaemonRestart } from "./agent-inventory-cmds";

describe("parseStamp", () => {
  it("reads src from --version output", () => {
    expect(parseStamp('{"src":"a1b2c3d"}\n')).toBe("a1b2c3d");
  });

  it("returns null for malformed json", () => {
    expect(parseStamp("not json")).toBeNull();
  });

  it("returns null when src is missing or empty", () => {
    expect(parseStamp('{"other":1}')).toBeNull();
    expect(parseStamp('{"src":""}')).toBeNull();
  });
});

describe("isUnknownMethodError", () => {
  it("matches the daemon's fallback error", () => {
    expect(isUnknownMethodError("unknown daemon method: daemon_build_id")).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isUnknownMethodError("ECONNREFUSED")).toBe(false);
  });
});

describe("daemonVerdict", () => {
  it("flags a mismatch as stale", () => {
    expect(daemonVerdict("9b16121", "a1b2c3d")).toBe("stale");
  });

  it("stays silent when the stamps match", () => {
    expect(daemonVerdict("a1b2c3d", "a1b2c3d")).toBe("silent");
  });

  it("stays silent when either stamp is missing", () => {
    expect(daemonVerdict(null, "a1b2c3d")).toBe("silent");
    expect(daemonVerdict("a1b2c3d", null)).toBe("silent");
  });

  // A git-less build stamps "unknown" — never prompt on a stamp we can't trust.
  it("stays silent when either stamp is unknown", () => {
    expect(daemonVerdict("unknown", "a1b2c3d")).toBe("silent");
    expect(daemonVerdict("a1b2c3d", "unknown")).toBe("silent");
  });
});

describe("refreshInventoryAfterDaemonRestart", () => {
  it("forces inventory refresh after a daemon restart", () => {
    const service = { refresh: vi.fn(async () => ({}) as never) };

    refreshInventoryAfterDaemonRestart(service);

    expect(service.refresh).toHaveBeenCalledTimes(1);
  });
});
