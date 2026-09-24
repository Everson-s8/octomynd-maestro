import path from "node:path";
import type { CommandOrigin } from "../commands/types.js";

/** Must match the npm package name, which Electron uses for Windows userData. */
export const PACKAGED_USER_DATA_DIRECTORY_NAME = "octomynd-maestro";

/** Origin marker used by CLI-originated commands (shared by chat and task commands). */
export function cliOrigin(): CommandOrigin {
  return { channel: "cli" };
}

/** Data directory for CLI-mode state; overridable with MAESTRO_DATA_DIR. */
export function cliDataDir(): string {
  const configured = process.env.MAESTRO_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  // The installed Windows launcher runs in the current project directory by
  // default, which previously created a second empty CLI database. The app's
  // Electron userData directory is %APPDATA%/<package name>.
  if (process.env.MAESTRO_CLI_MODE === "packaged" && process.env.APPDATA?.trim()) {
    return path.resolve(process.env.APPDATA, PACKAGED_USER_DATA_DIRECTORY_NAME);
  }

  return path.resolve(process.cwd());
}

/** SQLite database path for CLI-mode state; overridable with MAESTRO_DB_PATH. */
export function envDbPath(): string {
  const configured = process.env.MAESTRO_DB_PATH;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.resolve(cliDataDir(), configured ?? ".maestro/maestro.db");
}
