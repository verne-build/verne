import { describe, it, expect } from "vitest";
import { aggregateUsage, footprintToMB, agentPids, type AppMetric, type DaemonDiagnostics, type PidStat } from "./metrics-cmds";

const diag: DaemonDiagnostics = {
  daemonPid: 100, tabChildPids: [{ tabId: "t1", label: "zsh", pid: 200 }], agentCount: 2,
  activeSessions: 1, fileWatchers: 2, directoryWatchers: 1, gitWatchers: 0,
  cachedFileIndexes: 1, cachedFilePaths: 50, sourceControlVisible: true,
};

describe("aggregateUsage", () => {
  it("sums app metrics + measured pid trees over core count", () => {
    const app: AppMetric[] = [{ cpu: 20, memoryMB: 100 }, { cpu: 10, memoryMB: 50 }];
    const pidStats: Record<number, PidStat> = {
      100: { cpu: 5, memoryMB: 30 },
      200: { cpu: 15, memoryMB: 40 },
    };
    const usage = aggregateUsage({ app, pidStats, diag, lspCount: 3, numCores: 5 });
    expect(usage.cpu).toBeCloseTo(10);   // (20+10+5+15)/5
    expect(usage.ram).toBeCloseTo(220);  // 100+50+30+40
    expect(usage.tabCount).toBe(1);
    expect(usage.agentCount).toBe(2);
    expect(usage.lspCount).toBe(3);
  });
});

describe("footprintToMB", () => {
  it("normalizes macOS footprint units to MB", () => {
    expect(footprintToMB(407, "MB")).toBe(407);
    expect(footprintToMB(7217, "KB")).toBeCloseTo(7.0479, 3);
    expect(footprintToMB(2, "GB")).toBe(2048);
    expect(footprintToMB(1048576, "bytes")).toBe(1); // unknown unit → bytes
    expect(footprintToMB(403, "mb")).toBe(403);      // case-insensitive
  });
});

describe("agentPids", () => {
  // shell 45734 → claude 47515 (agent); idle shell 53193 has no children
  const kids = new Map<number, number[]>([[45734, [47515]], [53193, []]]);
  it("bills the agent (shell's direct child) when one is running", () => {
    expect(agentPids(45734, kids)).toEqual([47515]);
  });
  it("falls back to the shell pid when the tab is idle", () => {
    expect(agentPids(53193, kids)).toEqual([53193]);
  });
  it("falls back when the shell pid is unknown to the map", () => {
    expect(agentPids(99999, kids)).toEqual([99999]);
  });
});
