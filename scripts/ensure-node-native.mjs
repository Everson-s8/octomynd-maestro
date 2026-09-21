/* Ensure better-sqlite3 matches the Node runtime used by the local CLI.
 * Desktop packaging intentionally rebuilds it for Electron; a later CLI run
 * may use a different installed Node ABI, so repair that mismatch on demand.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const BetterSqlite3 = require("better-sqlite3");
  const probe = new BetterSqlite3(":memory:");
  probe.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("NODE_MODULE_VERSION") && !message.includes("better_sqlite3.node")) throw error;
  console.warn("[maestro] better-sqlite3 does not match this Node runtime; rebuilding it for the current Node...");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["rebuild", "better-sqlite3"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
