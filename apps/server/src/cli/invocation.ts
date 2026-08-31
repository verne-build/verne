import * as Effect from "effect/Effect";

import { HostProcessArguments } from "@t3tools/shared/hostProcess";
import { VERNE_CLI_COMMAND, VERNE_CLI_PACKAGE } from "@t3tools/shared/productIdentity";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort; callers must fail closed to a plain `verne` command.
 */
export function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

/**
 * The Verne package spec to suggest. The literal spec the user typed (e.g.
 * `@verne-build/cli@nightly`) is resolved away before our process starts, so re-derive it
 * from the running version: nightly builds re-suggest the nightly channel,
 * anything else suggests the bare package.
 */
export function suggestedPackageSpec(version: string): string {
  return version.includes("-nightly.") ? `${VERNE_CLI_PACKAGE}@nightly` : VERNE_CLI_PACKAGE;
}

/**
 * Render a `verne <subcommand>` suggestion that matches how this process was
 * launched, so copy/pasting it actually works: `npx @verne-build/cli connect` suggests
 * `npx @verne-build/cli serve`, a global install suggests `verne serve`, and a nightly build
 * keeps the `@nightly` tag.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const runner = detectCliRunner(input.entryPath);
  if (runner === null) {
    return `${VERNE_CLI_COMMAND} ${input.subcommand}`;
  }
  return `${runner} ${suggestedPackageSpec(input.version)} ${input.subcommand}`;
}

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcessArguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );
