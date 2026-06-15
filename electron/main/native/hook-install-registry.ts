import {
  ensureHooksForClaude,
  ensureHooksForCodex,
  ensureHooksForCopilot,
  ensureHooksForAntigravity,
  ensureHooksForCursor,
} from "./hook-writer";
import { ensurePluginForOpencode, ensurePluginForPi } from "./agent-plugins";

export interface HookInstallCtx {
  notifyScript: string;
  port: number;
  secret: string;
}

export type HookInstaller = (ctx: HookInstallCtx) => void;

/** agent key → installer. Config-hook agents use notifyScript; plugin agents
 *  bake in port+secret. Keys MUST match the daemon registry's integration set
 *  (agent_registry.rs). The coverage is asserted in hook-install-registry.test.ts. */
export const HOOK_INSTALLERS: Record<string, HookInstaller> = {
  claude: ({ notifyScript }) => ensureHooksForClaude(notifyScript),
  codex: ({ notifyScript }) => ensureHooksForCodex(notifyScript),
  copilot: ({ notifyScript }) => ensureHooksForCopilot(notifyScript),
  antigravity: ({ notifyScript }) => ensureHooksForAntigravity(notifyScript),
  cursor: ({ notifyScript }) => ensureHooksForCursor(notifyScript),
  opencode: ({ port, secret }) => ensurePluginForOpencode(port, secret),
  pi: ({ port, secret }) => ensurePluginForPi(port, secret),
};
