/*
 * Verify the complete Windows update artifact set before it is published.
 * electron-updater needs latest.yml beside the installer, and the blockmap is
 * required for differential updates. Publishing only the .exe creates a
 * release that installs successfully but cannot self-update.
 *
 * Usage:
 *   npm run verify:release
 *   npm run verify:release -- --github
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = String(packageJson.version);
const releaseDir = path.resolve(repoRoot, process.env.MAESTRO_RELEASE_DIR?.trim() || "release");
const installer = `Maestro-Setup-${version}-x64.exe`;
const required = [installer, `${installer}.blockmap`, "latest.yml", "Maestro-Setup.exe"];

function fail(message) {
  console.error(`[verify-release] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) fail(`release directory not found: ${releaseDir}`);

for (const name of required) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`required artifact is missing: release/${name}`);
  if (fs.statSync(file).size === 0) fail(`required artifact is empty: release/${name}`);
}

const latest = fs.readFileSync(path.join(releaseDir, "latest.yml"), "utf8");
if (!new RegExp(`^version:\\s*${version.replaceAll(".", "\\.")}\\s*$`, "m").test(latest)) {
  fail(`latest.yml does not declare package version ${version}`);
}
if (!new RegExp(`^\\s*-?\\s*url:\\s*${installer.replaceAll(".", "\\.")}\\s*$`, "m").test(latest)) {
  fail(`latest.yml does not point to ${installer}`);
}

console.log(`[verify-release] local artifacts ready for v${version}:`);
for (const name of required) console.log(`  ✓ release/${name}`);

if (process.argv.includes("--github")) {
  const raw = execFileSync("gh", [
    "release", "view", `v${version}`, "--repo", "Octomynd/octomynd-maestro", "--json", "assets"
  ], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const release = JSON.parse(raw);
  const uploaded = new Set((release.assets ?? []).map((asset) => asset.name));
  for (const name of required) {
    if (!uploaded.has(name)) fail(`GitHub release v${version} is missing asset ${name}`);
  }
  console.log(`[verify-release] GitHub release v${version} contains the NSIS update set and branded bootstrapper.`);
}
