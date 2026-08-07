import dotenv from "dotenv";
import path from "node:path";
import {
  assessExecutionPaths,
  ExecutionContract,
  isSupportedNodeVersion,
  resolveExecutionContract
} from "./execution/contract.js";
import {
  DEFAULT_ANTIGRAVITY_INACTIVITY_TIMEOUT_MS,
  DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS,
  DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS
} from "./agents/execution-limits.js";
import {
  isWorkGraphAdoptionMode,
  WORK_GRAPH_ADOPTION_MODES,
  type WorkGraphAdoptionMode
} from "./work-graphs/adoption.js";

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
    antigravityEnabled?: boolean;
    antigravityModel?: string | null;
    antigravityEffort?: "low" | "medium" | "high";
    antigravityInactivityTimeoutMs?: number;
    codexInactivityTimeoutMs?: number;
    claudeInactivityTimeoutMs?: number;
    providerMaxRuntimeMs?: number;
    goalDeadlineMs?: number;
  };
  workGraph: {
    adoptionMode: WorkGraphAdoptionMode;
  };
  skills: {
    enabled: boolean;
    catalogPath: string;
    versionsPath: string;
    projectKey: string;
    curator: {
      staleDays: number;
      autoArchiveEnabled: boolean;
      pollIntervalMs: number;
    };
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
      tokenEfficient: normalizeBoolean(env.MAESTRO_TOKEN_RUNTIME_ENABLED, true),
      antigravityEnabled: normalizeBoolean(env.MAESTRO_ANTIGRAVITY_ENABLED, true),
      antigravityModel: normalizeOptional(env.MAESTRO_ANTIGRAVITY_MODEL),
      antigravityEffort: normalizeEffort(env.MAESTRO_ANTIGRAVITY_EFFORT),
      antigravityInactivityTimeoutMs: normalizePositiveInteger(
        env.MAESTRO_ANTIGRAVITY_INACTIVITY_TIMEOUT_MS,
        DEFAULT_ANTIGRAVITY_INACTIVITY_TIMEOUT_MS,
        1_000
      ),
      codexInactivityTimeoutMs: normalizePositiveInteger(
        env.MAESTRO_CODEX_INACTIVITY_TIMEOUT_MS,
        DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS,
        1_000
      ),
      claudeInactivityTimeoutMs: normalizePositiveInteger(
        env.MAESTRO_CLAUDE_INACTIVITY_TIMEOUT_MS,
        DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS,
        1_000
      ),
      providerMaxRuntimeMs: normalizeOptionalPositiveInteger(
        env.MAESTRO_PROVIDER_MAX_RUNTIME_MS,
        60_000
      ),
      goalDeadlineMs: normalizeOptionalPositiveInteger(
        env.MAESTRO_GOAL_DEADLINE_MS,
        60_000
      )
    },
    workGraph: {
      adoptionMode: normalizeWorkGraphAdoptionMode(env.MAESTRO_WORK_GRAPH_MODE)
    },
    skills: {
      enabled: normalizeBoolean(env.MAESTRO_SKILLS_ENABLED, false),
      catalogPath: path.resolve(cwd, env.MAESTRO_SKILLS_PATH?.trim() || "skills"),
      versionsPath: path.resolve(
        cwd,
        env.MAESTRO_SKILL_VERSIONS_PATH?.trim() || ".maestro/skill-versions"
      ),
      projectKey: env.MAESTRO_SKILLS_PROJECT_KEY?.trim().toLowerCase() || "maestro",
      curator: {
        staleDays: normalizePositiveInteger(env.MAESTRO_SKILL_CURATOR_STALE_DAYS, 30, 1),
        autoArchiveEnabled: normalizeBoolean(env.MAESTRO_SKILL_CURATOR_AUTO_ARCHIVE_ENABLED, false),
        pollIntervalMs: normalizePositiveInteger(env.MAESTRO_SKILL_CURATOR_POLL_MS, 6 * 60 * 60_000, 60_000)
      }
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

  if (env.MAESTRO_WORK_GRAPH_MODE?.trim()) {
    const mode = env.MAESTRO_WORK_GRAPH_MODE.trim().toLowerCase();
    if (!isWorkGraphAdoptionMode(mode)) {
      errors.push(`MAESTRO_WORK_GRAPH_MODE must be one of: ${WORK_GRAPH_ADOPTION_MODES.join(", ")}.`);
    }
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

function normalizeWorkGraphAdoptionMode(value: string | undefined): WorkGraphAdoptionMode {
  const normalized = value?.trim().toLowerCase();
  return normalized && isWorkGraphAdoptionMode(normalized) ? normalized : "off";
}

function normalizeEffort(value: string | undefined): "low" | "medium" | "high" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "low" || normalized === "high" ? normalized : "medium";
}

function normalizeOptionalPositiveInteger(value: string | undefined, minimum: number): number | undefined {
  if (!value?.trim() || value.trim() === "0") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : undefined;
}
