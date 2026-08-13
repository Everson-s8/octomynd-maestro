import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCodexCliEntry } from "../agents/codex.js";
import { resolveClaudeCliCommand } from "../agents/claude.js";
import { resolveAntigravityExecutable } from "../agents/antigravity.js";
import type { AgentProviderId } from "../agents/types.js";

export type DetectedProviderInfo = {
  id: AgentProviderId;
  label: string;
  available: boolean;
  source: "cli" | "env_key" | "none";
  detail: string;
};

export type WizardDetectionResult = {
  providers: DetectedProviderInfo[];
  availableCount: number;
  ghAvailable: boolean;
  nodeVersion: string;
  envPath: string;
  createdEnv: boolean;
  summary: string;
};

import { resolveCustomCliExecutable } from "../agents/custom-cli.js";
import { parseCustomProviders } from "../config.js";

export function detectProviders(env: NodeJS.ProcessEnv = process.env): DetectedProviderInfo[] {
  const codexCli = resolveCodexCliEntry();
  const codexKey = env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const codexAvailable = Boolean(codexCli || codexKey);

  const claudeCli = resolveClaudeCliCommand();
  const claudeKey = env.CLAUDE_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim();
  const claudeAvailable = Boolean(claudeCli || claudeKey);

  const antigravityCli = resolveAntigravityExecutable();
  const antigravityKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  const antigravityAvailable = Boolean(antigravityCli || antigravityKey);

  const customConfigs = parseCustomProviders(env.MAESTRO_CUSTOM_PROVIDERS);
  const detectedCustom: DetectedProviderInfo[] = [];
  if (customConfigs) {
    for (const custom of customConfigs) {
      const cli = resolveCustomCliExecutable(custom.command);
      const envKeyPresent = Boolean(
        custom.envKeys?.some((key) => Boolean(env[key]?.trim()))
      );
      // A custom CLI provider only ever RUNS by spawning its command, so it is
      // not usable without a resolvable executable even when an env key exists
      // (execute() has no API-only path). envKeyPresent is surfaced for
      // diagnostics, but availability requires the CLI to resolve.
      const available = Boolean(cli);
      detectedCustom.push({
        id: custom.id,
        label: custom.label,
        available,
        source: cli ? "cli" : envKeyPresent ? "env_key" : "none",
        detail: cli
          ? `${custom.label} CLI detected`
          : envKeyPresent
            ? `${custom.label} env key present but CLI not found`
            : `${custom.label} CLI or API key missing`
      });
    }
  }

  return [
    {
      id: "codex",
      label: "Codex",
      available: codexAvailable,
      source: codexCli ? "cli" : codexKey ? "env_key" : "none",
      detail: codexCli
        ? "Codex CLI detected"
        : codexKey
          ? "Codex/OpenAI API key detected in ENV"
          : "Codex CLI or API key missing"
    },
    {
      id: "claude",
      label: "Claude",
      available: claudeAvailable,
      source: claudeCli ? "cli" : claudeKey ? "env_key" : "none",
      detail: claudeCli
        ? "Claude CLI detected"
        : claudeKey
          ? "Claude/Anthropic API key detected in ENV"
          : "Claude CLI or API key missing"
    },
    {
      id: "antigravity",
      label: "Gemini Antigravity",
      available: antigravityAvailable,
      source: antigravityCli ? "cli" : antigravityKey ? "env_key" : "none",
      detail: antigravityCli
        ? "Antigravity CLI detected"
        : antigravityKey
          ? "Gemini API key detected in ENV"
          : "Antigravity CLI or Gemini API key missing"
    },
    ...detectedCustom
  ];
}

export function isGhAvailable(): boolean {
  try {
    const executable = process.platform === "win32" ? "gh.exe" : "gh";
    const res = spawnSync(executable, ["--version"], { windowsHide: true, timeout: 5_000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function runConfigWizard(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): WizardDetectionResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const providers = detectProviders(env);
  const availableCount = providers.filter((p) => p.available).length;
  const ghAvailable = isGhAvailable();
  const envPath = path.join(cwd, ".env");
  const envExamplePath = path.join(cwd, ".env.example");
  let createdEnv = false;

  const antigravityInfo = providers.find((p) => p.id === "antigravity");
  const enableAntigravity = antigravityInfo?.available ?? true;

  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
      let content = fs.readFileSync(envExamplePath, "utf8");
      content = content.replace(
        /^MAESTRO_ANTIGRAVITY_ENABLED=.*$/m,
        `MAESTRO_ANTIGRAVITY_ENABLED=${enableAntigravity ? "true" : "false"}`
      );
      if (/^TELEGRAM_BOT_TOKEN=\s*$/m.test(content) || !/^TELEGRAM_BOT_TOKEN=/m.test(content)) {
        content = content.replace(
          /^TELEGRAM_BOT_TOKEN=\s*$/m,
          "TELEGRAM_BOT_TOKEN=dummy_token_for_local_setup"
        );
      }
      fs.writeFileSync(envPath, content, "utf8");
    } else {
      const defaultEnv = [
        "TELEGRAM_BOT_TOKEN=dummy_token_for_local_setup",
        "TELEGRAM_ALLOWED_USER_ID=",
        "MAESTRO_PROJECT_NAME=octomynd-maestro",
        "MAESTRO_DB_PATH=.maestro/maestro.db",
        `MAESTRO_ANTIGRAVITY_ENABLED=${enableAntigravity ? "true" : "false"}`
      ].join("\n");
      fs.writeFileSync(envPath, defaultEnv, "utf8");
    }
    createdEnv = true;
  } else {
    let existingContent = fs.readFileSync(envPath, "utf8");
    if (/^TELEGRAM_BOT_TOKEN=\s*$/m.test(existingContent)) {
      existingContent = existingContent.replace(
        /^TELEGRAM_BOT_TOKEN=\s*$/m,
        "TELEGRAM_BOT_TOKEN=dummy_token_for_local_setup"
      );
      fs.writeFileSync(envPath, existingContent, "utf8");
    }
  }

  const lines: string[] = [
    "=== Octomynd Maestro Configuration Wizard ===",
    `Node.js runtime: ${process.version}`,
    `Detected Providers (${availableCount} available):`,
    ...providers.map((p) => `  [${p.available ? "x" : " "}] ${p.label}: ${p.detail}`),
    `GitHub CLI (gh): ${ghAvailable ? "Available" : "Not installed (Optional - PR creation will operate in local mode)"}`,
    `Environment file: ${createdEnv ? "Generated .env" : "Using existing .env"}`
  ];

  if (availableCount === 0) {
    lines.push("[!] Warning: No provider CLI or API key detected. Install at least ONE provider CLI (codex, claude, or agy) or set an API key in ENV.");
  } else if (availableCount === 1) {
    const single = providers.find((p) => p.available)!;
    lines.push(`[+] Single-provider setup active: Maestro will route all capabilities using ${single.label}.`);
  } else {
    lines.push(`[+] Multi-provider setup active: ${availableCount} providers ready for capability routing.`);
  }

  const summary = lines.join("\n");
  return {
    providers,
    availableCount,
    ghAvailable,
    nodeVersion: process.version,
    envPath,
    createdEnv,
    summary
  };
}
