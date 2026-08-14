import fs from "node:fs";
import path from "node:path";
import type { AgentCapability, CustomCliProviderConfig } from "./types.js";

/**
 * Provider presets + `.env` persistence for custom CLI providers.
 *
 * The Maestro process reads custom providers at startup from
 * `MAESTRO_CUSTOM_PROVIDERS` (a JSON array in `.env.local`/`.env`). The
 * dashboard needs to let the user register a new provider and delete one at
 * runtime, so we persist the current set back into the env file using the same
 * file convention as `updateEnvTelegramConfig`.
 *
 * NOTE: a running Maestro instance applies custom providers at boot (index.ts).
 * Persisting + restarting applies the change; the endpoint here only writes the
 * env file so the next start (or a supervised self-update/restart) picks it up.
 */

const ALL_CAPABILITIES: AgentCapability[] = [
  "planning",
  "coding",
  "testing",
  "reviewing",
  "improvement_reviewing",
  "research",
  "conversation"
];

export type ProviderPreset = {
  id: string;
  label: string;
  command: string;
  args?: string[];
  envKeys?: string[];
  description: string;
  /** Provider model(s) the preset can point at; empty = whatever the CLI supports. */
  models?: string[];
  /** Human hint about connection mode (account/oauth vs api key). */
  connectionHint: "account" | "api_key" | "local";
};

/**
 * Curated presets. These are templates the user can start from and tweak;
 * they are intentionally not exhaustive — users can type any command.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    command: "claude",
    args: ["-p"],
    description: "Claude Code — CLI com acesso por conta (login) ou API key.",
    models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-3-7-sonnet", "claude-3-5-sonnet"],
    connectionHint: "account"
  },
  {
    id: "anthropic-api",
    label: "Anthropic via API",
    command: "claude",
    args: ["-p", "--api-key"],
    envKeys: ["ANTHROPIC_API_KEY"],
    description: "Claude Code via ANTHROPIC_API_KEY.",
    models: ["claude-sonnet-4-6", "claude-opus-4-6"],
    connectionHint: "api_key"
  },
  {
    id: "codex",
    label: "Codex (OpenAI)",
    command: "codex",
    args: ["exec"],
    description: "OpenAI Codex CLI (conta ou CODEX_API_KEY).",
    models: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
    connectionHint: "account"
  },
  {
    id: "openai-api",
    label: "OpenAI / OpenRouter via API",
    command: "opencode",
    args: ["-m", "gpt-4o"],
    envKeys: ["OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    description: "Modelos OpenAI-compatible via API key.",
    models: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini", "deepseek-v4-flash"],
    connectionHint: "api_key"
  },
  {
    id: "opencode-go",
    label: "OpenCode Go (deepseek-v4-flash)",
    command: "opencode",
    args: ["-m", "opencode/deepseek-v4-flash"],
    description: "OpenCode Go apontando para deepseek-v4-flash.",
    models: ["opencode/deepseek-v4-flash", "deepseek-v4-flash"],
    connectionHint: "api_key"
  },
  {
    id: "deepseek",
    label: "DeepSeek (API)",
    command: "opencode",
    args: ["-m", "deepseek-chat"],
    envKeys: ["DEEPSEEK_API_KEY"],
    description: "DeepSeek via API key (Opencode Go).",
    models: ["deepseek-chat", "deepseek-reasoner"],
    connectionHint: "api_key"
  },
  {
    id: "gemini",
    label: "Gemini (Antigravity)",
    command: "antigravity",
    description: "Gemini Antigravity CLI — modelos dinâmicos por conta.",
    models: ["gemini-3.7-flash-medium", "gemini-3.7-flash-high", "gemini-3.7-flash-low"],
    connectionHint: "account"
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    command: "ollama",
    args: ["run"],
    description: "Modelos locais via Ollama.",
    models: ["llama3.1", "qwen2.5", "deepseek-r1"],
    connectionHint: "local"
  },
  {
    id: "copilot",
    label: "GitHub Copilot (CLI)",
    command: "gh",
    args: ["copilot"],
    description: "GitHub Copilot CLI (conta GitHub).",
    connectionHint: "account"
  }
];

/** Derive a CustomCliProviderConfig from a preset + user command/args. */
export function configFromPreset(
  preset: ProviderPreset,
  options: {
    id?: string;
    label?: string;
    command?: string;
    args?: string[];
    model?: string | null;
    capabilities?: AgentCapability[];
  } = {}
): CustomCliProviderConfig {
  return {
    id: options.id?.trim() || preset.id,
    label: options.label?.trim() || preset.label,
    command: options.command?.trim() || preset.command,
    args: options.args && options.args.length ? options.args : preset.args,
    envKeys: options.args ? preset.envKeys : preset.envKeys,
    capabilities: options.capabilities ?? ALL_CAPABILITIES,
    healthProbe: false,
    model: options.model ?? null,
    models: preset.models
  };
}

export function resolveEnvFilePath(cwd = process.cwd()): string {
  return fs.existsSync(path.join(cwd, ".env.local"))
    ? path.join(cwd, ".env.local")
    : path.join(cwd, ".env");
}

export function readCustomProviders(cwd = process.cwd()): CustomCliProviderConfig[] {
  const envPath = resolveEnvFilePath(cwd);
  if (!fs.existsSync(envPath)) return [];
  const raw = envValue(fs.readFileSync(envPath, "utf8"), "MAESTRO_CUSTOM_PROVIDERS");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is CustomCliProviderConfig => Boolean(item && typeof item.id === "string" && typeof item.command === "string"))
      : [];
  } catch {
    return [];
  }
}

export function writeCustomProviders(providers: CustomCliProviderConfig[], cwd = process.cwd()): {
  success: boolean;
  envPath: string;
  count: number;
} {
  const envPath = resolveEnvFilePath(cwd);
  const json = JSON.stringify(providers);
  const line = `MAESTRO_CUSTOM_PROVIDERS=${json}`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, line + "\n", "utf8");
    return { success: true, envPath, count: providers.length };
  }

  const content = fs.readFileSync(envPath, "utf8");
  let next: string;
  if (/^MAESTRO_CUSTOM_PROVIDERS=.*$/m.test(content)) {
    next = content.replace(/^MAESTRO_CUSTOM_PROVIDERS=.*$/m, line);
  } else {
    next = content + (content.endsWith("\n") || content === "" ? "" : "\n") + line + "\n";
  }
  fs.writeFileSync(envPath, next, "utf8");
  return { success: true, envPath, count: providers.length };
}

export function addCustomProvider(provider: CustomCliProviderConfig, cwd = process.cwd()): {
  success: boolean;
  envPath: string;
  providers: CustomCliProviderConfig[];
} {
  const current = readCustomProviders(cwd);
  const next = current.filter((item) => item.id !== provider.id).concat(provider);
  writeCustomProviders(next, cwd);
  return { success: true, envPath: resolveEnvFilePath(cwd), providers: next };
}

export function removeCustomProvider(id: string, cwd = process.cwd()): {
  success: boolean;
  envPath: string;
  providers: CustomCliProviderConfig[];
  removed: boolean;
} {
  const current = readCustomProviders(cwd);
  const before = current.length;
  const next = current.filter((item) => item.id !== id);
  if (next.length === before) return { success: true, envPath: resolveEnvFilePath(cwd), providers: current, removed: false };
  writeCustomProviders(next, cwd);
  return { success: true, envPath: resolveEnvFilePath(cwd), providers: next, removed: true };
}

function envValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match) return "";
  let value = match[1].trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return value;
}
