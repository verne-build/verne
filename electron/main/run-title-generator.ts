// The one piece that genuinely touches the OS: spawn the generator, feed the
// prompt on stdin, read the title back out of -o <tmpfile>. Deliberately thin —
// all decision-making lives in session-title.ts, which is unit-tested.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentBinary } from "./agent-binary";
import type { TitleGenerator } from "./title-generator-registry";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probe(path: string): boolean {
  try {
    return spawnSync(path, ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** The user's real interactive PATH. A GUI app's PATH lacks ~/.local/bin. */
function loginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    const out = spawnSync(shell, ["-lc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
    });
    return out.status === 0 && out.stdout ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Returns the raw generated text, or null on ANY failure. Never throws. */
export async function runTitleGenerator(input: {
  generator: TitleGenerator;
  agentBin?: string | null;
  cwd: string;
  prompt: string;
}): Promise<string | null> {
  const { generator, agentBin, cwd, prompt } = input;
  // Cached per app run only once a path resolves, or once a reportedBin was
  // supplied and failed. If the hook reports no agentBin AND the binary is
  // genuinely missing, the miss is NOT cached, so the full probe chain
  // (spawnSync calls + login shell) re-runs on every call. Acceptable: title
  // generation is once-per-session.
  const bin = resolveAgentBinary({
    binaryName: generator.binaryName,
    reportedBin: agentBin,
    env: process.env,
    homedir,
    isExecutable,
    probe,
    loginShellPath,
  });
  if (!bin) return null;

  const dir = mkdtempSync(join(tmpdir(), "verne-title-"));
  const outFile = join(dir, "title.txt");
  try {
    return await new Promise<string | null>((resolve) => {
      // Strip Verne hook-attribution vars before spawning. `codex exec` reads
      // ~/.codex/hooks.json and fires its OWN hooks through Verne's notify
      // script; if VERNE_TAB_ID leaks in (inherited from a dev app launched
      // inside a Verne tab), those hooks get attributed to that unrelated
      // tab — including an agent-title-requested whose prompt is THIS
      // summarize instruction, permanently freezing that tab's title to junk.
      // Same class of bug as the daemon-env-leaks-into-PTYs issue. Keep
      // PATH/HOME/etc — the child legitimately needs those plus codex's own
      // auth/config vars.
      const env = { ...process.env };
      delete env.VERNE_TAB_ID;
      delete env.VERNE_AGENT_ID;
      delete env.VERNE_AGENT_TYPE;
      const child = spawn(bin, generator.args({ cwd, outFile }), {
        cwd,
        env,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // Same class of bug as child.stdin below: an unlistened stream error
      // (e.g. EPIPE) would crash the whole process. The data handler above
      // already consumes the stream so it can't block the child either.
      child.stderr?.on("error", () => {});
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        console.warn(
          `[title-generator] timed out after ${generator.timeoutMs}ms; stderr: ${stderr.slice(-500)}`,
        );
        resolve(null);
      }, generator.timeoutMs);
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.warn(
            `[title-generator] exited ${code}; stderr: ${stderr.slice(-500)}`,
          );
          return resolve(null);
        }
        try {
          resolve(readFileSync(outFile, "utf8"));
        } catch {
          resolve(null);
        }
      });
      // child.stdin is its own EventEmitter; a write failure (e.g. EPIPE when
      // the child exits before reading) emits 'error' on the STREAM, not on
      // `child`, and not as a thrown exception — an unlistened stream error
      // crashes the whole process. Attach a listener before .end() so it's
      // merely swallowed; the child 'error'/'close'/timeout paths above
      // already settle the promise with null (resolve is idempotent).
      child.stdin.on("error", () => {});
      // Prompt on stdin, never argv: no shell quoting, no ~256KB argv cap.
      child.stdin.end(generator.instruction(prompt));
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}
