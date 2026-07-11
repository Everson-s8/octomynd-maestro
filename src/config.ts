import dotenv from "dotenv";
import path from "node:path";

export type MaestroConfig = {
  projectName: string;
  databasePath: string;
  telegram: {
    botToken: string;
    allowedUserId: string | null;
  };
};

export function loadConfig(cwd = process.cwd(), env = process.env): MaestroConfig {
  dotenv.config({ path: path.join(cwd, ".env.local"), override: false });
  dotenv.config({ path: path.join(cwd, ".env"), override: false });

  return {
    projectName: env.MAESTRO_PROJECT_NAME?.trim() || "octomynd-maestro",
    databasePath: path.resolve(cwd, env.MAESTRO_DB_PATH?.trim() || ".maestro/maestro.db"),
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN?.trim() || "",
      allowedUserId: normalizeOptional(env.TELEGRAM_ALLOWED_USER_ID)
    }
  };
}

export function validateRuntimeConfig(config: MaestroConfig): string[] {
  const errors: string[] = [];

  if (!config.telegram.botToken) {
    errors.push("TELEGRAM_BOT_TOKEN is missing. Set it in .env.local.");
  }

  if (config.telegram.allowedUserId && !/^\d+$/.test(config.telegram.allowedUserId)) {
    errors.push("TELEGRAM_ALLOWED_USER_ID must contain only digits.");
  }

  return errors;
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
