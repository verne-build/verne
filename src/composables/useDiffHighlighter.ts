/// <reference types="vite/client" />
import PierreWorker from "@pierre/diffs/worker/worker.js?worker";
import { preloadHighlighter } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { registerVerneInjectionsWithPierre } from "@/lib/diffsLanguages";
import { registerVerneTheme } from "@/lib/diffsTheme";
import { useTheme } from "./useTheme";

// Pierre's WorkerPoolManager calls resolveLanguages() on the main thread per
// request and forwards resolved data to the worker via task.resolvedLanguages.
// Since registerCustomLanguage populates the main-thread registry, our custom
// grammars DO reach the worker — provided each loader returns the full
// embedded-language tree (handled in diffsLanguages.ts).
//
// Languages preloaded on worker init. Vue is the heaviest (embeds html/css/
// js/ts/scss/etc.), so resolving it eagerly avoids a multi-second stall on
// the first Vue diff open. Each language's grammar is small (a few KB), but
// resolving Vue cascades to ~10 embedded grammars — that's where the cost is.
const PRELOAD_LANGS = [
  "vue", "tsx", "typescript", "jsx", "javascript",
  "html", "css", "scss",
  "json", "jsonc", "yaml", "toml",
  "markdown",
  "rust", "go", "python", "shell",
] as const;

type Setup = { workerManager: WorkerPoolManager | undefined };

let setupPromise: Promise<Setup> | null = null;

function spawnWorker(): Worker | null {
  try {
    return new PierreWorker();
  } catch (e) {
    console.warn("[diffs] worker spawn failed; using main-thread highlighter", e);
    return null;
  }
}

async function setup(): Promise<Setup> {
  const { activeThemeName, getActiveThemeSpec } = useTheme();

  // Make sure the *initial* Verne theme is registered with pierre before
  // we initialize the highlighter — useTheme may not have run applyTheme
  // yet when the first DiffView mounts.
  const initialTheme = activeThemeName.value;
  registerVerneTheme(initialTheme, getActiveThemeSpec());

  // Custom injection grammars Shiki doesn't ship.
  const injectionLangs = registerVerneInjectionsWithPierre();

  // Main-thread highlighter: include common langs so resolveLanguages()
  // hits cache during the first FileDiff render instead of dynamic-importing.
  const langs = [...injectionLangs, ...PRELOAD_LANGS];
  await preloadHighlighter({
    themes: [initialTheme as any],
    langs: langs as any,
  });

  const probeWorker = spawnWorker();
  if (!probeWorker) return { workerManager: undefined };
  probeWorker.terminate();

  // Worker init: forwarding `langs` triggers WorkerPoolManager.initialize(langs)
  // which resolves on main thread + attaches them to the worker upfront. Without
  // this, the worker only learns each language on its first render, paying the
  // full grammar-resolve + postMessage cost mid-interaction.
  const workerManager = getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () => new PierreWorker(),
      poolSize: 1,
    },
    highlighterOptions: {
      theme: initialTheme as any,
      langs: langs as any,
    },
  });

  return { workerManager };
}

export function useDiffHighlighter(): Promise<Setup> {
  if (!setupPromise) setupPromise = setup();
  return setupPromise;
}
