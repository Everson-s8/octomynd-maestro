import path from "node:path";
import type { CommandOrigin } from "../commands/types.js";

/** Origin marker used by CLI-originated commands (shared by chat and task commands). */
export function cliOrigin(): CommandOrigin {
  return { channel: "cli" };
}

/** Data directory for CLI-mode state; overridable with MAESTRO_DATA_DIR. */
export function cliDataDir(): string {
  return path.resolve(process.env.MAESTRO_DATA_DIR?.trim() || process.cwd());
}

/** SQLite database path for CLI-mode state; overridable with MAESTRO_DB_PATH. */
export function envDbPath(): string {
  const configured = process.env.MAESTRO_DB_PATH;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.resolve(cliDataDir(), configured ?? ".maestro/maestro.db");
}
