import dotenv from "dotenv";
import path from "node:path";
import {
  assessExecutionPaths,
  ExecutionContract,
  isSupportedNodeVersion,
  resolveExecutionContract
} from "./execution/contract.js";

export type MaestroConfig = {
  projectName: string;
  databasePath: string;
  worktreesPath: string;
  execution: ExecutionContract;
  dashboard: {
    enabled: boolean;
    host: string;
    port: number;
  };
  autopilot: {
    enabled: boolean;
    pollIntervalMs: number;
    maxConcurrentGoals: number;
  };
  runtime: {
    tokenEfficient: boolean;
  };
  skills: {
    enabled: boolean;
    catalogPath: string;
    versionsPath: string;
    projectKey: string;
  };
  telegram: {
    botToken: string;
    allowedUserId: string | null;
  };
};

export function loadConfig(cwd = process.cwd(), env = process.env): MaestroConfig {
  dotenv.config({ path: path.join(cwd, ".env.local"), override: false });
  dotenv.config({ path: path.join(cwd, ".env"), override: false });

  const projectName = env.MAESTRO_PROJECT_NAME?.trim() || "octomynd-maestro";
  const execution = resolveExecutionContract(cwd, projectName, env);

  return {
    projectName,
    databasePath: path.resolve(cwd, env.MAESTRO_DB_PATH?.trim() || ".maestro/maestro.db"),
    worktreesPath: execution.worktreesPath,
    execution,
    dashboard: {
      enabled: normalizeBoolean(env.MAESTRO_DASHBOARD_ENABLED, true),
      host: env.MAESTRO_DASHBOARD_HOST?.trim() || "127.0.0.1",
      port: normalizePort(env.MAESTRO_DASHBOARD_PORT, 4787)
    },
    autopilot: {
      enabled: normalizeBoolean(env.MAESTRO_AUTOPILOT_ENABLED, true),
      pollIntervalMs: normalizePositiveInteger(env.MAESTRO_AUTOPILOT_POLL_MS, 30_000, 1_000),
      maxConcurrentGoals: normalizePositiveInteger(env.MAESTRO_AUTOPILOT_MAX_CONCURRENT, 1, 1)
    },
    runtime: {
      tokenEfficient: normalizeBoolean(env.MAESTRO_TOKEN_RUNTIME_ENABLED, true)
    },
    skills: {
      enabled: normalizeBoolean(env.MAESTRO_SKILLS_ENABLED, false),
      catalogPath: path.resolve(cwd, env.MAESTRO_SKILLS_PATH?.trim() || "skills"),
      versionsPath: path.resolve(
        cwd,
        env.MAESTRO_SKILL_VERSIONS_PATH?.trim() || ".maestro/skill-versions"
      ),
      projectKey: env.MAESTRO_SKILLS_PROJECT_KEY?.trim().toLowerCase() || "maestro"
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN?.trim() || "",
      allowedUserId: normalizeOptional(env.TELEGRAM_ALLOWED_USER_ID)
    }
  };
}

export function validateRuntimeConfig(
  config: MaestroConfig,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const errors: string[] = [];

  if (!config.telegram.botToken) {
    errors.push("TELEGRAM_BOT_TOKEN is missing. Set it in .env.local.");
  }

  if (config.telegram.allowedUserId && !/^\d+$/.test(config.telegram.allowedUserId)) {
    errors.push("TELEGRAM_ALLOWED_USER_ID must contain only digits.");
  }

  if (config.dashboard.host !== "127.0.0.1" && config.dashboard.host !== "localhost") {
    errors.push("MAESTRO_DASHBOARD_HOST must stay local: use 127.0.0.1 or localhost.");
  }

  if (!isSupportedNodeVersion(process.version, config.execution.expectedNodeVersion)) {
    errors.push(
      `Node ${config.execution.expectedNodeVersion}.x is required; current runtime is ${process.version}.`
    );
  }

  if (process.platform === "win32") {
    errors.push(...assessExecutionPaths(config.execution, env).reasons);
  }

  return errors;
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) {
    return fallback;
  }
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

function normalizePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function normalizePositiveInteger(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
