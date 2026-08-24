/*
 * Clean, reproducible build of the packaged Maestro desktop artifacts.
 *
 * Runs with the app's own Node/npm — no bespoke toolchain. It:
 *   1. wipes previous build outputs (dist/, release/) for a from-scratch build
 *   2. builds the React UI (ui/dist)
 *   3. compiles the TypeScript backend to plain ESM JS (dist/) so the packaged
 *      app needs no tsx/node/npm on the target machine to launch. Git and
 *      provider CLIs remain integration prerequisites for task workflows.
 *
 * Packaging the installer itself is `npm run dist:win`; `npm run release:win`
 * chains this script and then electron-builder. Kept separate so a machine
 * without the Windows packaging toolchain can still validate the compile step.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function run(label, command, args) {
  process.stdout.write(`\n[build-desktop] ${label}\n`);
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    process.stderr.write(`[build-desktop] step failed: ${label}\n`);
    process.exit(result.status ?? 1);
  }
}

function clean(target) {
  const full = path.join(repoRoot, target);
  fs.rmSync(full, { recursive: true, force: true });
  process.stdout.write(`[build-desktop] cleaned ${target}\n`);
}

clean("dist");
clean("release");
run("Building UI (vite)", npmCmd, ["run", "build:ui"]);
run("Compiling backend (tsc)", npmCmd, ["run", "build:backend"]);

// Guard: the packaged app cannot boot without these outputs.
for (const required of ["dist/index.js", "ui/dist/index.html"]) {
  if (!fs.existsSync(path.join(repoRoot, required))) {
    process.stderr.write(`[build-desktop] expected build output missing: ${required}\n`);
    process.exit(1);
  }
}

process.stdout.write("\n[build-desktop] Clean build complete. Run 'npm run dist:win' to package the installer.\n");
