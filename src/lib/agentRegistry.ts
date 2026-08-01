import type { AgentInventoryKey, AgentLaunchSelection, AgentType } from "../types";

export interface ModelDefinition {
  id: string;
  label: string;
  cliValue: string;
  efforts?: readonly string[];
  fast?: "claude-settings" | "codex-tier";
  cursorVariants?: Readonly<Record<string, string>>;
}

export interface AgentDefinition {
  type: AgentType;
  inventoryKey: AgentInventoryKey;
  label: string;
  bin: string;
  models: readonly ModelDefinition[];
}

const MODEL_VALUES = {
  claude: ["fable", "sonnet", "opus"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
  opencode: ["opencode/big-pickle", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.5", "openai/gpt-5.4"],
} as const;

const AGY_MODELS = [
  "Gemini 3.6 Flash (High)", "Gemini 3.6 Flash (Medium)", "Gemini 3.6 Flash (Low)",
  "Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (Low)",
  "Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)",
] as const;

const CURSOR_VARIANTS = {
  auto: { "default:off": "auto" },
  "composer-2.5": { "default:off": "composer-2.5", "default:on": "composer-2.5-fast" },
  "gpt-5.6-sol": {
    "default:off": "gpt-5.6-sol-medium", "default:on": "gpt-5.6-sol-medium-fast",
    "low:off": "gpt-5.6-sol-low", "low:on": "gpt-5.6-sol-low-fast",
    "medium:off": "gpt-5.6-sol-medium", "medium:on": "gpt-5.6-sol-medium-fast",
    "high:off": "gpt-5.6-sol-high", "high:on": "gpt-5.6-sol-high-fast",
    "xhigh:off": "gpt-5.6-sol-xhigh", "xhigh:on": "gpt-5.6-sol-xhigh-fast",
    "max:off": "gpt-5.6-sol-max", "max:on": "gpt-5.6-sol-max-fast",
  },
  "claude-opus-4-8": {
    "default:off": "claude-opus-4-8-high", "default:on": "claude-opus-4-8-high-fast",
    "low:off": "claude-opus-4-8-low", "low:on": "claude-opus-4-8-low-fast",
    "medium:off": "claude-opus-4-8-medium", "medium:on": "claude-opus-4-8-medium-fast",
    "high:off": "claude-opus-4-8-high", "high:on": "claude-opus-4-8-high-fast",
    "xhigh:off": "claude-opus-4-8-xhigh", "xhigh:on": "claude-opus-4-8-xhigh-fast",
    "max:off": "claude-opus-4-8-max", "max:on": "claude-opus-4-8-max-fast",
  },
  "claude-fable-5": {
    "default:off": "claude-fable-5-high", "low:off": "claude-fable-5-low",
    "medium:off": "claude-fable-5-medium", "high:off": "claude-fable-5-high",
    "xhigh:off": "claude-fable-5-xhigh", "max:off": "claude-fable-5-max",
  },
  "claude-sonnet-5": {
    "default:off": "claude-sonnet-5-high", "low:off": "claude-sonnet-5-low",
    "medium:off": "claude-sonnet-5-medium", "high:off": "claude-sonnet-5-high",
    "xhigh:off": "claude-sonnet-5-xhigh", "max:off": "claude-sonnet-5-max",
  },
  "gpt-5.5": {
    "default:off": "gpt-5.5-medium", "default:on": "gpt-5.5-medium-fast",
    "low:off": "gpt-5.5-low", "low:on": "gpt-5.5-low-fast",
    "medium:off": "gpt-5.5-medium", "medium:on": "gpt-5.5-medium-fast",
    "xhigh:off": "gpt-5.5-extra-high", "xhigh:on": "gpt-5.5-extra-high-fast",
  },
  "gpt-5.4": {
    "default:off": "gpt-5.4-medium", "default:on": "gpt-5.4-medium-fast",
    "low:off": "gpt-5.4-low", "medium:off": "gpt-5.4-medium", "medium:on": "gpt-5.4-medium-fast",
    "high:off": "gpt-5.4-high", "high:on": "gpt-5.4-high-fast",
    "xhigh:off": "gpt-5.4-xhigh", "xhigh:on": "gpt-5.4-xhigh-fast",
  },
} as const;

const CLAUDE_EFFORTS = ["low", "medium", "high"] as const;
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function titleCaseModelId(id: string): string {
  return id
    .split("/")
    .map((part) => part.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "))
    .join("/");
}

function modelsFor(values: readonly string[]): ModelDefinition[] {
  return values.map((id) => ({ id, label: titleCaseModelId(id), cliValue: id }));
}

const claudeModels = modelsFor(MODEL_VALUES.claude).map((model) => ({
  ...model,
  efforts: CLAUDE_EFFORTS,
  ...(model.id === "opus" ? { fast: "claude-settings" as const } : {}),
}));
const codexModels = modelsFor(MODEL_VALUES.codex).map((model) => ({
  ...model,
  efforts: CODEX_EFFORTS,
  fast: "codex-tier" as const,
}));
const cursorModels = Object.entries(CURSOR_VARIANTS).map(([id, cursorVariants]) => ({
  id,
  label: titleCaseModelId(id),
  cliValue: id,
  cursorVariants,
}));

export const AGENT_REGISTRY: readonly AgentDefinition[] = [
  { type: "claude", inventoryKey: "claude", label: "Claude", bin: "claude", models: claudeModels },
  { type: "codex", inventoryKey: "codex", label: "Codex", bin: "codex", models: codexModels },
  { type: "opencode", inventoryKey: "opencode", label: "OpenCode", bin: "opencode", models: modelsFor(MODEL_VALUES.opencode) },
  { type: "agy", inventoryKey: "antigravity", label: "Antigravity", bin: "agy", models: AGY_MODELS.map((id) => ({ id, label: id, cliValue: id })) },
  { type: "cursor", inventoryKey: "cursor", label: "Cursor", bin: "cursor-agent", models: cursorModels },
];

export function getAgentDefinition(type: AgentType): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((agent) => agent.type === type);
}

export function getModelDefinition(
  agent: AgentType | AgentDefinition,
  modelId: string,
): ModelDefinition | undefined {
  const definition = typeof agent === "string" ? getAgentDefinition(agent) : agent;
  return definition?.models.find((model) => model.id === modelId);
}

/** Efforts a model exposes; `[]` for Terminal (no model) or an untunable model. */
export function effortsFor(model: ModelDefinition | null | undefined): string[] {
  if (!model) return [];
  if (model.efforts) return [...model.efforts];
  return [...new Set(Object.keys(model.cursorVariants ?? {})
    .map((variant) => variant.split(":")[0]!)
    .filter((effort) => effort !== "default"))];
}

export function supportsFastFor(model: ModelDefinition | null | undefined): boolean {
  return !!model?.fast || Object.keys(model?.cursorVariants ?? {}).some((variant) => variant.endsWith(":on"));
}

/** Label for the combined Effort / Fast Mode trigger. Effort is shown unless the model is fast-only. */
export function tuningLabel(input: {
  efforts: readonly string[];
  supportsFast: boolean;
  effort: string | null;
  fast: boolean;
}): string {
  const labels: string[] = [];
  if (input.efforts.length > 0 || !input.supportsFast)
    labels.push(input.effort
      ? `Effort ${input.effort[0]!.toUpperCase()}${input.effort.slice(1)}`
      : "Effort Default");
  if (input.supportsFast) labels.push(`Fast Mode ${input.fast ? "On" : "Off"}`);
  return labels.join(" · ");
}

export function buildAgentArgv(selection: AgentLaunchSelection): string[] {
  const agent = getAgentDefinition(selection.agentType);
  if (!agent) throw new Error(`Unknown agent type: ${selection.agentType}`);
  const argv = [agent.bin];

  if (selection.modelId === null) {
    if (selection.effort !== null) throw new Error("Effort is unavailable without a model");
    if (selection.fast !== null) throw new Error("Fast mode is unavailable");
    return argv;
  }

  const model = getModelDefinition(agent, selection.modelId);
  if (!model) throw new Error(`Unknown ${agent.label} model`);

  if (agent.type === "cursor") {
    const variant = model.cursorVariants?.[`${selection.effort ?? "default"}:${selection.fast ? "on" : "off"}`];
    if (!variant) throw new Error("Unknown Cursor launch variant");
    return [...argv, "--model", variant];
  }

  argv.push("--model", model.cliValue);
  if (selection.effort !== null) {
    if (!model.efforts?.includes(selection.effort)) throw new Error(`Effort ${selection.effort} is unavailable`);
    if (agent.type === "codex") argv.push("-c", `model_reasoning_effort=\"${selection.effort}\"`);
    else argv.push("--effort", selection.effort);
  }

  if (selection.fast !== null) {
    if (!model.fast) throw new Error("Fast mode is unavailable");
    if (model.fast === "claude-settings") argv.push("--settings", JSON.stringify({ fastMode: selection.fast }));
    else argv.push("-c", `service_tier=\"${selection.fast ? "priority" : "default"}\"`);
  }

  return argv;
}

export function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function serializeArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error("Launch argv cannot be empty");
  return argv.map(quotePosixArg).join(" ");
}

// Hidden from the new-session picker only. Registry entry stays so existing
// sessions keep their label, detection, and hooks.
const PICKER_HIDDEN: ReadonlySet<AgentType> = new Set<AgentType>(["cursor"]);

export function filterLaunchAgents(installed: ReadonlySet<AgentInventoryKey>): AgentDefinition[] {
  return AGENT_REGISTRY.filter((agent) =>
    installed.has(agent.inventoryKey) && !PICKER_HIDDEN.has(agent.type),
  );
}
