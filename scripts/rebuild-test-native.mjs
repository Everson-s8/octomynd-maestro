/* F7: restore the Node-ABI build of better-sqlite3 after desktop packaging.
 *
 * The desktop build pipeline (`release:win`) rebuilds better-sqlite3 against
 * Electron (NODE_MODULE_VERSION 132). Any vitest run after that crashes with
 * the infamous "compiled against a different Node.js version" error until a
 * manual `npm rebuild better-sqlite3` is executed — which then breaks the next
 * packaging, and so on.
 *
 * This script flips the binding back to the local Node ABI. It is wired as the
 * npm `postrelease:win` hook and can also be run manually:
 *   node scripts/rebuild-test-native.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

console.log("[rebuild-test-native] Restoring better-sqlite3 for the local Node runtime...");
const result = spawnSync("npm", ["rebuild", "better-sqlite3"], {
  cwd: repoRoot,
  stdio: "inherit",
  windowsHide: true,
  shell: process.platform === "win32"
});

if (result.status !== 0) process.exit(result.status ?? 1);
