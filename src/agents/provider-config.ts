import fs from "node:fs";
import path from "node:path";
import type { AgentCapability, CustomCliProviderConfig } from "./types.js";

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
  models?: string[];
  connectionHint: "account" | "api_key" | "local";
  category: "account" | "api" | "local";
  docsUrl: string;
  setupCommand?: string;
  apiKeyEnv?: string;
  defaultEndpoint?: string;
  builtIn?: boolean;
  authFlow?: "device_code" | "terminal" | "none";
  authArgs?: string[];
  authStatusArgs?: string[];
  modelDiscovery?: "cli" | "endpoint" | "ollama" | "manual";
  modelDiscoveryArgs?: string[];
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    args: ["-p", "{prompt}", "--output-format", "text"],
    description: "Claude Code usando a assinatura ou credenciais já conectadas no CLI.",
    models: [],
    connectionHint: "account",
    category: "account",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    setupCommand: "claude auth login",
    authFlow: "terminal",
    authArgs: ["auth", "login"],
    authStatusArgs: ["auth", "status"],
    modelDiscovery: "manual",
    builtIn: true
  },
  {
    id: "anthropic-api",
    label: "Anthropic API",
    command: "claude",
    args: ["-p", "{prompt}", "--output-format", "text"],
    envKeys: ["ANTHROPIC_API_KEY"],
    description: "Claude Code usando uma API key da Anthropic.",
    models: [],
    connectionHint: "api_key",
    category: "api",
    docsUrl: "https://console.anthropic.com/settings/keys",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelDiscovery: "manual"
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    args: ["exec", "{prompt}"],
    description: "OpenAI Codex CLI usando a conta conectada.",
    models: [],
    connectionHint: "account",
    category: "account",
    docsUrl: "https://developers.openai.com/codex/cli",
    setupCommand: "codex login",
    authFlow: "device_code",
    authArgs: ["login", "--device-auth"],
    authStatusArgs: ["login", "status"],
    modelDiscovery: "manual",
    builtIn: true
  },
  {
    id: "openai-api",
    label: "OpenAI API",
    command: "opencode",
    args: ["run", "{prompt}", "-m", "{model}"],
    envKeys: ["OPENAI_API_KEY"],
    description: "Modelos OpenAI pelo OpenCode usando uma API key.",
    models: [],
    connectionHint: "api_key",
    category: "api",
    docsUrl: "https://platform.openai.com/api-keys",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultEndpoint: "https://api.openai.com/v1",
    modelDiscovery: "endpoint"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    command: "opencode",
    args: ["run", "{prompt}", "-m", "{model}"],
    envKeys: ["OPENROUTER_API_KEY"],
    description: "Catálogo amplo de modelos por uma única API OpenAI-compatible.",
    models: [],
    connectionHint: "api_key",
    category: "api",
    docsUrl: "https://openrouter.ai/settings/keys",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultEndpoint: "https://openrouter.ai/api/v1",
    modelDiscovery: "endpoint"
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    command: "opencode",
    args: ["run", "{prompt}", "-m", "{model}"],
    description: "Modelos disponíveis na conta conectada ao OpenCode.",
    envKeys: ["OPENCODE_GO_API_KEY"],
    models: [],
    connectionHint: "api_key",
    category: "api",
    docsUrl: "https://opencode.ai/docs/zen/",
    apiKeyEnv: "OPENCODE_GO_API_KEY",
    defaultEndpoint: "https://opencode.ai/zen/go/v1",
    modelDiscovery: "cli",
    modelDiscoveryArgs: ["models", "opencode"]
  },
  {
    id: "deepseek",
    label: "DeepSeek API",
    command: "opencode",
    args: ["run", "{prompt}", "-m", "{model}"],
    envKeys: ["DEEPSEEK_API_KEY"],
    description: "DeepSeek usando uma API key própria.",
    models: [],
    connectionHint: "api_key",
    category: "api",
    docsUrl: "https://platform.deepseek.com/api_keys",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultEndpoint: "https://api.deepseek.com",
    modelDiscovery: "endpoint"
  },
  {
    id: "gemini",
    label: "Gemini Antigravity",
    command: "antigravity",
    description: "Gemini Antigravity usando a conta Google conectada.",
    models: [],
    connectionHint: "account",
    category: "account",
    docsUrl: "https://antigravity.google/",
    setupCommand: "antigravity",
    authFlow: "terminal",
    authArgs: [],
    modelDiscovery: "manual",
    builtIn: true
  },
  {
    id: "ollama",
    label: "Ollama",
    command: "ollama",
    args: ["run", "{model}", "{prompt}"],
    description: "Modelos locais executados pelo Ollama.",
    models: [],
    connectionHint: "local",
    category: "local",
    docsUrl: "https://ollama.com/download",
    setupCommand: "ollama serve",
    defaultEndpoint: "http://127.0.0.1:11434",
    modelDiscovery: "ollama"
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    command: "gh",
    args: ["copilot", "suggest", "{prompt}"],
    description: "GitHub Copilot usando a conta autenticada no GitHub CLI.",
    connectionHint: "account",
    category: "account",
    docsUrl: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    setupCommand: "gh auth login",
    authFlow: "terminal",
    authArgs: ["auth", "login"],
    authStatusArgs: ["auth", "status"],
    modelDiscovery: "manual"
  }
];

export function configFromPreset(
  preset: ProviderPreset,
  options: {
    id?: string;
    label?: string;
    command?: string;
    args?: string[];
    model?: string | null;
    capabilities?: AgentCapability[];
    endpointUrl?: string | null;
    connectionMode?: CustomCliProviderConfig["connectionMode"];
  } = {}
): CustomCliProviderConfig {
  return {
    id: options.id?.trim() || preset.id,
    label: options.label?.trim() || preset.label,
    command: options.command?.trim() || preset.command,
    args: options.args && options.args.length ? options.args : preset.args,
    envKeys: preset.envKeys,
    capabilities: options.capabilities ?? ALL_CAPABILITIES,
    healthProbe: false,
    model: options.model ?? null,
    models: preset.models,
    presetId: preset.id,
    connectionMode: options.connectionMode ?? preset.connectionHint,
    endpointUrl: options.endpointUrl ?? preset.defaultEndpoint ?? null,
    apiKeyEnv: preset.apiKeyEnv ?? null,
    docsUrl: preset.docsUrl,
    setupCommand: preset.setupCommand ?? null,
    modelDiscovery: preset.modelDiscovery,
    modelDiscoveryArgs: preset.modelDiscoveryArgs
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

export function mergeCustomProviders(
  configured: CustomCliProviderConfig[] | undefined,
  persisted: CustomCliProviderConfig[]
): CustomCliProviderConfig[] {
  const merged = new Map<string, CustomCliProviderConfig>();
  for (const provider of configured ?? []) {
    merged.set(provider.id, provider);
  }
  for (const provider of persisted) {
    merged.set(provider.id, provider);
  }
  return [...merged.values()];
}

export function writeCustomProviders(providers: CustomCliProviderConfig[], cwd = process.cwd()): {
  success: boolean;
  envPath: string;
  count: number;
} {
  const envPath = resolveEnvFilePath(cwd);
  const line = `MAESTRO_CUSTOM_PROVIDERS=${JSON.stringify(providers)}`;
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const next = /^MAESTRO_CUSTOM_PROVIDERS=.*$/m.test(content)
    ? content.replace(/^MAESTRO_CUSTOM_PROVIDERS=.*$/m, line)
    : `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
  fs.writeFileSync(envPath, next, "utf8");
  return { success: true, envPath, count: providers.length };
}

export function addCustomProvider(provider: CustomCliProviderConfig, cwd = process.cwd()) {
  const current = readCustomProviders(cwd);
  const previous = current.find((item) => item.id === provider.id);
  const providers = current.filter((item) => item.id !== provider.id).concat(provider);
  writeCustomProviders(providers, cwd);
  if (previous?.managedSecret && previous.apiKeyEnv !== provider.apiKeyEnv) {
    removeManagedProviderSecret(previous, providers, cwd);
  }
  return { success: true, envPath: resolveEnvFilePath(cwd), providers };
}

export function removeCustomProvider(id: string, cwd = process.cwd()) {
  const current = readCustomProviders(cwd);
  const providers = current.filter((item) => item.id !== id);
  if (providers.length === current.length) {
    return { success: true, envPath: resolveEnvFilePath(cwd), providers: current, removed: false };
  }
  writeCustomProviders(providers, cwd);
  const removedProvider = current.find((item) => item.id === id);
  if (removedProvider) removeManagedProviderSecret(removedProvider, providers, cwd);
  return { success: true, envPath: resolveEnvFilePath(cwd), providers, removed: true };
}

export function writeProviderSecret(envKey: string, value: string, cwd = process.cwd()): string {
  const key = envKey.trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid_provider_secret_key");
  if (!value.trim()) throw new Error("provider_secret_is_required");
  const envPath = resolveEnvFilePath(cwd);
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value.trim()}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
  fs.writeFileSync(envPath, next, "utf8");
  process.env[key] = value.trim();
  return envPath;
}

function removeManagedProviderSecret(
  provider: CustomCliProviderConfig,
  remainingProviders: CustomCliProviderConfig[],
  cwd: string
): void {
  const key = provider.apiKeyEnv?.trim();
  if (!provider.managedSecret || !key || !/^[A-Z][A-Z0-9_]*$/.test(key)) return;
  if (remainingProviders.some((item) => item.apiKeyEnv === key)) return;
  const envPath = resolveEnvFilePath(cwd);
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  const pattern = new RegExp(`^${key}=.*(?:\\r?\\n|$)`, "m");
  if (!pattern.test(content)) return;
  fs.writeFileSync(envPath, content.replace(pattern, ""), "utf8");
  delete process.env[key];
}

function envValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match) return "";
  let value = match[1].trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return value;
}
