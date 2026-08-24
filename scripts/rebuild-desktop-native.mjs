/* Rebuild native dependencies against the Electron runtime that will ship. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPackage = path.join(repoRoot, "node_modules", "electron", "package.json");
const rebuildCli = path.join(repoRoot, "node_modules", "@electron", "rebuild", "lib", "cli.js");

if (!fs.existsSync(electronPackage) || !fs.existsSync(rebuildCli)) {
  console.error("[rebuild-desktop-native] Electron or @electron/rebuild is unavailable. Run npm ci first.");
  process.exit(1);
}

const electronVersion = JSON.parse(fs.readFileSync(electronPackage, "utf8")).version;
console.log(`[rebuild-desktop-native] Rebuilding better-sqlite3 for Electron ${electronVersion}...`);

const result = spawnSync(process.execPath, [rebuildCli, "--force", "--which-module", "better-sqlite3", "--version", electronVersion], {
  cwd: repoRoot,
  stdio: "inherit",
  windowsHide: true
});

if (result.status !== 0) process.exit(result.status ?? 1);
