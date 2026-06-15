import { app } from "electron";
import { cpus } from "node:os";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import pidusage from "pidusage";
import { registerNative } from "../ipc-router";
import type { DaemonClient } from "../daemon-client";
import { getDb } from "../db/connection";
import { agentCount } from "../db/tabs";

export interface AppMetric { cpu: number; memoryMB: number; }
export interface PidStat { cpu: number; memoryMB: number; }
export interface DaemonDiagnostics {
  daemonPid: number;
  tabChildPids: { tabId: string; label: string; pid: number }[];
  agentCount: number;
  activeSessions: number; fileWatchers: number; directoryWatchers: number;
  gitWatchers: number; cachedFileIndexes: number; cachedFilePaths: number;
  sourceControlVisible: boolean;
}
// Daemon serves the session/tab half; the sidecar serves the watcher/cache half.
interface RawDaemonDiag {
  daemonPid: number;
  tabChildPids: { tabId: string; label: string; pid: number }[];
  activeSessions: number;
}
interface SidecarDiag {
  sidecarPid: number; agentCount: number;
  fileWatchers: number; directoryWatchers: number; gitWatchers: number;
  cachedFileIndexes: number; cachedFilePaths: number; sourceControlVisible: boolean;
}
export interface ResourceUsage { cpu: number; ram: number; agentCount: number; tabCount: number; lspCount: number; }

/** Pure: combine Electron app-process metrics + externally-measured pid-tree
 *  stats into the renderer's ResourceUsage shape. CPU normalized by cores. */
export function aggregateUsage(o: {
  app: AppMetric[]; pidStats: Record<number, PidStat>; diag: DaemonDiagnostics;
  lspCount: number; numCores: number;
}): ResourceUsage {
  let cpu = 0, ram = 0;
  for (const m of o.app) { cpu += m.cpu; ram += m.memoryMB; }
  for (const s of Object.values(o.pidStats)) { cpu += s.cpu; ram += s.memoryMB; }
  return {
    cpu: cpu / Math.max(1, o.numCores),
    ram,
    agentCount: o.diag.agentCount,
    tabCount: o.diag.tabChildPids.length,
    lspCount: o.lspCount,
  };
}

const execFileP = promisify(execFile);

/** footprint prints e.g. "phys_footprint: 407 MB" / "7217 KB" — normalize to MB. */
export function footprintToMB(value: number, unit: string): number {
  switch (unit.toUpperCase()) {
    case "GB": return value * 1024;
    case "MB": return value;
    case "KB": return value / 1024;
    default: return value / 1024 / 1024; // bytes
  }
}
const FOOTPRINT_RE = /phys_footprint:\s+([\d.]+)\s*(GB|MB|KB|bytes)/i;

/** RSS(MB) per pid via pidusage (`ps`). Cross-platform fallback + the win path. */
async function rssMB(pids: number[]): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  if (!pids.length) return out;
  try {
    const stats = await pidusage(pids);
    for (const [pid, s] of Object.entries(stats)) if (s) out[Number(pid)] = s.memory / 1024 / 1024;
  } catch { /* all pids gone */ }
  return out;
}

/** "Real memory" per pid in MB, using each OS's own accounting so totals match
 *  the platform monitor (Activity Monitor / `stats`): macOS phys_footprint,
 *  Linux PSS (smaps_rollup), else RSS. RSS (what `ps`/workingSetSize report)
 *  over-counts shared pages and inflates sums — see footprintToMB. Dead/denied
 *  pids fall back to RSS so a row never silently vanishes. */
async function memoryMB(pids: number[]): Promise<Record<number, number>> {
  if (!pids.length) return {};
  const out: Record<number, number> = {};
  if (process.platform === "darwin") {
    await Promise.all(pids.map(async pid => {
      try {
        const { stdout } = await execFileP("/usr/bin/footprint", ["-p", String(pid)]);
        const m = stdout.match(FOOTPRINT_RE);
        if (m) out[pid] = footprintToMB(parseFloat(m[1]), m[2]);
      } catch { /* dead/denied → RSS fallback below */ }
    }));
  } else if (process.platform === "linux") {
    await Promise.all(pids.map(async pid => {
      try {
        const txt = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
        const m = txt.match(/^Pss:\s+(\d+)\s*kB/m);
        if (m) out[pid] = parseInt(m[1], 10) / 1024;
      } catch { /* fall back to RSS below */ }
    }));
  }
  const missing = pids.filter(p => !(p in out));
  if (missing.length) Object.assign(out, await rssMB(missing));
  return out;
}

/** Map each requested pid → its direct child pids (one `ps` pass). A tab's
 *  tracked pid is the login SHELL the PTY spawned (~4MB); the agent (claude/
 *  codex) runs as that shell's direct child, and the MCP servers/tools it
 *  spawns nest one level deeper under the agent. So the agent process — the
 *  thing the OS monitor shows as "claude" — is the shell's direct child:
 *  measuring the shell pid alone reports the shell (~4MB), and summing the
 *  whole subtree reports agent + every MCP server (GBs). */
async function childrenOf(pids: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>(pids.map(p => [p, []]));
  if (!pids.length) return map;
  try {
    const { stdout } = await execFileP("ps", ["-axo", "pid=,ppid="]);
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const arr = map.get(Number(m[2]));
      if (arr) arr.push(Number(m[1]));
    }
  } catch { /* ps failed → no children; callers fall back to the shell pid */ }
  return map;
}

/** Resolve a tab's tracked shell pid to the pid(s) to bill it for: the shell's
 *  direct children (the running agent) — or the shell itself when idle. */
export function agentPids(shellPid: number, kids: Map<number, number[]>): number[] {
  const c = kids.get(shellPid) ?? [];
  return c.length ? c : [shellPid];
}

/** CPU% + RAM(MB) per pid. CPU via pidusage (`ps pcpu`, a lifetime average on
 *  macOS — smoother than instantaneous); RAM via the OS real-memory metric.
 *  pidusage only errors when EVERY pid is gone, so one mid-measure exit doesn't
 *  lose the batch. Pids with no surviving data are dropped. */
async function statsFor(pids: number[]): Promise<Record<number, PidStat>> {
  const out: Record<number, PidStat> = {};
  if (!pids.length) return out;
  const [mem, cpu] = await Promise.all([
    memoryMB(pids),
    pidusage(pids).catch(() => ({} as Record<string, { cpu: number } | undefined>)),
  ]);
  for (const pid of pids) {
    const m = mem[pid]; const c = cpu[pid]?.cpu;
    if (m !== undefined || c !== undefined) out[pid] = { cpu: c ?? 0, memoryMB: m ?? 0 };
  }
  return out;
}

/** Per Electron process: CPU from getAppMetrics, RAM via the OS real-memory
 *  metric (footprint/PSS) keyed by pid — NOT workingSetSize, which is RSS and
 *  double-counts the shared framework across helpers. */
async function appMetrics(): Promise<AppMetric[]> {
  const rows = app.getAppMetrics();
  const mem = await memoryMB(rows.map(r => r.pid));
  return rows.map(m => ({
    cpu: m.cpu?.percentCPUUsage ?? 0,
    memoryMB: mem[m.pid] ?? (m.memory?.workingSetSize ?? 0) / 1024, // KB fallback
  }));
}

/** Fetch both halves of the diagnostics and merge into the combined shape the
 *  rest of the resource monitor expects. */
async function fetchDiag(daemon: DaemonClient, sidecar: DaemonClient): Promise<DaemonDiagnostics & { sidecarPid: number }> {
  const [d, s] = await Promise.all([
    daemon.request("get_daemon_diagnostics", null) as Promise<RawDaemonDiag>,
    sidecar.request("get_sidecar_diagnostics", null) as Promise<SidecarDiag>,
  ]);
  return {
    daemonPid: d.daemonPid,
    tabChildPids: d.tabChildPids,
    activeSessions: d.activeSessions,
    sidecarPid: s.sidecarPid,
    // Electron owns the tabs DB now; the sidecar reports 0 — count here.
    agentCount: agentCount(getDb()),
    fileWatchers: s.fileWatchers,
    directoryWatchers: s.directoryWatchers,
    gitWatchers: s.gitWatchers,
    cachedFileIndexes: s.cachedFileIndexes,
    cachedFilePaths: s.cachedFilePaths,
    sourceControlVisible: s.sourceControlVisible,
  };
}

export function registerMetricsCommands(
  daemon: DaemonClient,
  sidecar: DaemonClient,
  lspCountFn: () => number,
  lspPidsFn: () => number[],
): void {
  const numCores = cpus().length;
  const norm = (c: number) => c / Math.max(1, numCores);
  let cache: { at: number; usage: ResourceUsage } | null = null;

  registerNative("get_resource_usage", async () => {
    if (cache && Date.now() - cache.at < 1000) return cache.usage;
    const diag = await fetchDiag(daemon, sidecar);
    // Bill each tab for its agent process (the shell's direct child), not the
    // shell (~4MB) nor the whole subtree (agent + every MCP server). Daemon/
    // sidecar/LSP are directly-spawned single processes — measured as-is.
    const tabPids = diag.tabChildPids.map(t => t.pid);
    const kids = await childrenOf(tabPids);
    const roots = [diag.daemonPid, diag.sidecarPid, ...tabPids.flatMap(p => agentPids(p, kids)), ...lspPidsFn()];
    const [pidStats, appRows] = await Promise.all([statsFor(roots), appMetrics()]);
    const usage = aggregateUsage({ app: appRows, pidStats, diag, lspCount: lspCountFn(), numCores });
    cache = { at: Date.now(), usage };
    return usage;
  });

  registerNative("get_debug_metrics", async () => {
    const diag = await fetchDiag(daemon, sidecar);

    // Each tab is billed for its agent process (the shell's direct child), not
    // the shell pid nor the whole MCP subtree. Daemon/sidecar/LSP measured
    // directly. No descendant trees → no double-counting.
    const lspPids = lspPidsFn();
    const tabPids = diag.tabChildPids.map(t => t.pid);
    const kids = await childrenOf(tabPids);
    const tabAgent = new Map(diag.tabChildPids.map(t => [t.tabId, agentPids(t.pid, kids)]));
    const [stats, appRows] = await Promise.all([
      statsFor([diag.daemonPid, diag.sidecarPid, ...lspPids, ...[...tabAgent.values()].flat()]),
      appMetrics(),
    ]);
    const one = (pid: number, k: "cpu" | "memoryMB") => stats[pid]?.[k] ?? 0;
    const sumPids = (pids: number[], k: "cpu" | "memoryMB") => pids.reduce((a, p) => a + one(p, k), 0);

    const breakdown: { name: string; ram: number; cpu: number; tabId?: string }[] = [
      { name: "App (UI + Renderer)", ram: appRows.reduce((a, m) => a + m.memoryMB, 0), cpu: norm(appRows.reduce((a, m) => a + m.cpu, 0)) },
      { name: "Daemon", ram: one(diag.daemonPid, "memoryMB"), cpu: norm(one(diag.daemonPid, "cpu")) },
      { name: "Sidecar", ram: one(diag.sidecarPid, "memoryMB"), cpu: norm(one(diag.sidecarPid, "cpu")) },
    ];
    if (lspPids.length) breakdown.push({ name: "LSP", ram: sumPids(lspPids, "memoryMB"), cpu: norm(sumPids(lspPids, "cpu")) });
    diag.tabChildPids.forEach(t => {
      const pids = tabAgent.get(t.tabId) ?? [t.pid];
      breakdown.push({ name: `Tab: ${t.label}`, ram: sumPids(pids, "memoryMB"), cpu: norm(sumPids(pids, "cpu")), tabId: t.tabId });
    });

    return {
      activeSessions: diag.activeSessions,
      fileWatchers: diag.fileWatchers,
      directoryWatchers: diag.directoryWatchers,
      gitWatchers: diag.gitWatchers,
      cachedFileIndexes: diag.cachedFileIndexes,
      cachedFilePaths: diag.cachedFilePaths,
      lspCount: lspCountFn(),
      sourceControlVisible: diag.sourceControlVisible,
      processBreakdown: breakdown,
      // Same `stats`/`appRows` sample feeds both → headline reconciles w/ rows.
      usage: aggregateUsage({ app: appRows, pidStats: stats, diag, lspCount: lspCountFn(), numCores }),
    };
  });
}
