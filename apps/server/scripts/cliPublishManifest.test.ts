// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

import { createPublishPackageJson } from "./cliPublishManifest.ts";

const executableResourceMonitors = [
  "dist/resource-monitor/darwin-arm64/t3-resource-monitor",
  "dist/resource-monitor/darwin-x64/t3-resource-monitor",
  "dist/resource-monitor/linux-x64/t3-resource-monitor",
] as const;

it("packs POSIX resource monitors as executable files", () => {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "verne-cli-pack-test-"));

  try {
    const packageRoot = NodePath.join(tempRoot, "package");
    const packRoot = NodePath.join(tempRoot, "packed");
    const extractRoot = NodePath.join(tempRoot, "extracted");
    NodeFS.mkdirSync(packageRoot, { recursive: true });
    NodeFS.mkdirSync(packRoot, { recursive: true });
    NodeFS.mkdirSync(extractRoot, { recursive: true });

    const packageJson = createPublishPackageJson({
      serverPackageJson: {
        name: "@verne-build/cli-pack-test",
        repository: {
          type: "git",
          url: "https://github.com/verne-build/verne",
          directory: "apps/server",
        },
        bin: { verne: "./dist/bin.mjs" },
        type: "module",
        version: "0.0.35",
        engines: { node: ">=24" },
        files: ["dist"],
        dependencies: {},
        publishConfig: { executableFiles: [...executableResourceMonitors] },
      },
      workspaceConfig: {},
      version: "0.0.36",
    });

    NodeFS.writeFileSync(
      NodePath.join(packageRoot, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const binPath = NodePath.join(packageRoot, "dist/bin.mjs");
    NodeFS.mkdirSync(NodePath.dirname(binPath), { recursive: true });
    NodeFS.writeFileSync(binPath, "#!/usr/bin/env node\n");

    for (const relativePath of executableResourceMonitors) {
      const binaryPath = NodePath.join(packageRoot, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(binaryPath), { recursive: true });
      NodeFS.writeFileSync(binaryPath, "resource monitor");
      NodeFS.chmodSync(binaryPath, 0o644);
    }

    NodeChildProcess.execFileSync("vp", ["pm", "pack", "--pack-destination", packRoot], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    const tarball = NodeFS.readdirSync(packRoot).find((entry) => entry.endsWith(".tgz"));
    assert.ok(tarball, "Expected vp pm pack to create a tarball.");
    NodeChildProcess.execFileSync(
      "tar",
      ["-xzf", NodePath.join(packRoot, tarball), "-C", extractRoot],
      { stdio: "pipe" },
    );

    for (const relativePath of executableResourceMonitors) {
      const mode = NodeFS.statSync(NodePath.join(extractRoot, "package", relativePath)).mode;
      assert.notEqual(mode & 0o111, 0, `${relativePath} must be executable in the tarball.`);
    }
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }
});
