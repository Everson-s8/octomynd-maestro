import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = path.join(repoRoot, "installer");
const cargoDir = path.join(installerDir, "src-tauri");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Execute via npm run build:installer para localizar o npm com segurança.");

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, MAESTRO_PRODUCT_VERSION: String(packageJson.version) }
  });
}

if (process.platform !== "win32") {
  throw new Error("O bootstrapper Maestro Setup só pode ser compilado no Windows.");
}

run(process.execPath, [npmCli, "ci"], installerDir);
run("cargo", ["test", "--release"], cargoDir);
run(process.execPath, [npmCli, "run", "tauri:build", "--", "--config", JSON.stringify({ version: String(packageJson.version) })], installerDir);

const source = path.join(cargoDir, "target", "release", "Maestro-Setup.exe");
const releaseDir = path.join(repoRoot, "release");
const destination = path.join(releaseDir, "Maestro-Setup.exe");
if (!fs.existsSync(source) || fs.statSync(source).size === 0) {
  throw new Error(`O build não gerou um executável válido: ${source}`);
}
fs.mkdirSync(releaseDir, { recursive: true });
fs.copyFileSync(source, destination);
console.log(`[installer] Maestro-Setup.exe pronto para a release ${packageJson.version}: ${destination}`);
