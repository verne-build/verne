// @effect-diagnostics nodeBuiltinImport:off - static brand audit reads source files as fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const allowedT3CodeCopy = new Map<string, ReadonlyArray<string>>([
  ["index.css", ["original T3 Code artwork palettes"]],
  ["main.tsx", ["import T3 Code browser preferences"]],
  ["connection/storage.ts", ["legacy T3 Code connection catalog"]],
]);

const sourceRoot = NodePath.resolve(import.meta.dirname);

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(?:css|ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [path];
  });

it("keeps T3 Code copy at explicit attribution and migration boundaries", () => {
  const unexpected: string[] = [];
  for (const filePath of sourceFiles(sourceRoot)) {
    const relativePath = NodePath.relative(sourceRoot, filePath).replaceAll("\\", "/");
    const allowed = allowedT3CodeCopy.get(relativePath) ?? [];
    for (const [index, line] of NodeFS.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
      if (!line.includes("T3 Code")) continue;
      if (allowed.some((fragment) => line.includes(fragment))) continue;
      unexpected.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    }
  }

  expect(unexpected).toEqual([]);
});
