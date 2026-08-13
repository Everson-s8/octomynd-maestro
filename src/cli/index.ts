#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawn } from "node:child_process";
import { runConfigWizard } from "../config/wizard.js";
import { runTelegramConnectWizard } from "../telegram/connect.js";
import { createDatabase } from "../db.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { CommandOrigin } from "../commands/types.js";
import {
  resolveDesktopPaths,
  parseDesktopCliOptions,
  isUiDistMissing,
  isUiDistStale,
  checkApiHealth
} from "../desktop/launcher.js";
import { findProcessOnPort, killProcessGracefully } from "../runtime/port-process.js";

function cliOrigin(): CommandOrigin {
  return { channel: "maestro" };
}

/** Portable lookup for a command on PATH (works on Windows and POSIX). */
function commandAvailable(command: string): boolean {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    execSync(process.platform === "win32" ? `${probe} ${command}` : `${probe} ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function envDbPath(): string {
  const configured = process.env.MAESTRO_DB_PATH;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.resolve(process.cwd(), configured ?? ".maestro/maestro.db");
}

function printHelp(): void {
  console.log(`maestro — Octomynd Maestro CLI

Usage: maestro <command> [options]

Commands:
  setup                 Run the interactive configuration wizard (providers, GitHub).
  telegram connect      Connect your Telegram bot (token from @BotFather).
  project add <key> <path|github-url>
                        Register a local Git project, or clone a GitHub URL and register it.
  start                 Launch the Maestro orchestrator (dashboard UI + API + workers).
  restart [--port N] [--host H]
                        Restart a running Maestro process on the current code.
  dashboard             Launch the web dashboard UI (http://127.0.0.1:4788).
  desktop [--skip-build]
                        Launch Maestro as a native desktop app (Electron).
  status                Show what is installed, connected, and ready.
`);
}

async function projectAddCommand(argv: string[]): Promise<void> {
  const key = argv[0];
  const target = argv[1];
  if (!key || !target) {
    console.error("Usage: maestro project add <key> <path|github-url>");
    process.exit(1);
  }

  let projectPath = target;
  const githubMatch = /^(?:https?:\/\/|git@)(?:www\.)?github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(target);
  if (githubMatch) {
    const repo = githubMatch[1];
    const dest = path.resolve(process.cwd(), key);
    if (!fs.existsSync(dest)) {
      console.log(`[..] Clonando https://github.com/${repo} em ${dest}`);
      const url = `https://github.com/${repo}`;
      execFileSync("git", ["clone", url, dest], { stdio: "inherit" });
    }
    projectPath = dest;
  }

  if (!fs.existsSync(command_path_dir(projectPath))) {
    console.error(`[!] Caminho nao encontrado: ${projectPath}`);
    process.exit(1);
  }

  const dbPath = envDbPath();
  const database = createDatabase(dbPath);
  const commands = new ApplicationCommands(database);

  try {
    const result = commands.registerProject(cliOrigin(), {
      key,
      path: projectPath,
      defaultBranch: "main"
    });
    for (const warning of result.warnings) console.log(`[~] ${warning}`);
    console.log(`[ok] Projeto @${key} registrado em ${result.project.path}`);
  } catch (error) {
    console.error(`[!] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function command_path_dir(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

async function startCommand(): Promise<void> {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const srcIndex = path.resolve(cliDir, "../index.ts");
  const tsxCli = path.resolve(cliDir, "../../node_modules/tsx/dist/cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    console.error(`[!] tsx not found at ${tsxCli}. Run 'npm install' in the Maestro checkout first.`);
    process.exit(1);
  }
  if (!fs.existsSync(srcIndex)) {
    console.error(`[!] Orchestrator entry not found at ${srcIndex}`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [tsxCli, srcIndex], {
    cwd: process.cwd(),
    stdio: "inherit"
  });
  child.on("close", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
}

function parseRestartCliOptions(argv: string[]): { port: number; host: string } {
  // Defaults come from the same env the orchestrator reads, so a non-standard
  // port is picked up without the user passing --port; 4787 is only the last
  // resort when neither env nor flag is set.
  const envPort = Number.parseInt(process.env.MAESTRO_DASHBOARD_PORT ?? "", 10);
  let port = Number.isFinite(envPort) && envPort > 0 ? envPort : 4787;
  let host = process.env.MAESTRO_DASHBOARD_HOST?.trim() || "127.0.0.1";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      const p = parseInt(argv[i + 1], 10);
      if (!isNaN(p)) port = p;
    }
    if (argv[i] === "--host" && argv[i + 1]) {
      host = argv[i + 1];
    }
  }
  return { port, host };
}

async function restartCommand(argv: string[]): Promise<void> {
  const { port, host } = parseRestartCliOptions(argv);

  console.log(`[..] Looking for a Maestro process on port ${port}...`);
  const pid = await findProcessOnPort(port);
  if (!pid) {
    console.error(`[!] No process is listening on port ${port}. Maestro is not running here.`);
    process.exit(1);
  }

  console.log(`[..] Stopping process ${pid}...`);
  await killProcessGracefully(pid);

  const stillOwned = await findProcessOnPort(port);
  if (stillOwned) {
    console.error(`[!] Unable to free port ${port} (process ${stillOwned} still listening).`);
    process.exit(1);
  }
  console.log(`[ok] Port ${port} is free.`);

  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const srcIndex = path.resolve(cliDir, "../index.ts");
  const tsxCli = path.resolve(cliDir, "../../node_modules/tsx/dist/cli.mjs");
  if (!fs.existsSync(tsxCli) || !fs.existsSync(srcIndex)) {
    console.error("[!] Unable to locate orchestrator entry files.");
    process.exit(1);
  }

  console.log("[..] Relaunching Maestro on the current code...");
  const relaunchEnv = { ...process.env };
  // Propagate a non-default port/host so the relaunched process boots on the
  // same endpoint the health check polls (the orchestrator reads these from env).
  if (port !== 4787) relaunchEnv.MAESTRO_DASHBOARD_PORT = String(port);
  if (host !== "127.0.0.1") relaunchEnv.MAESTRO_DASHBOARD_HOST = host;
  const child = spawn(process.execPath, [tsxCli, srcIndex], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: relaunchEnv
  });
  child.on("error", (err) => {
    console.error(`[!] Failed to spawn the Maestro process: ${err.message}`);
    process.exit(1);
  });
  child.unref();

  let attempts = 0;
  let healthy = false;
  while (attempts < 60) {
    await new Promise((r) => setTimeout(r, 500));
    if (await checkApiHealth(host, port, 1000)) {
      healthy = true;
      break;
    }
    attempts++;
  }

  if (!healthy) {
    console.error(`[!] Maestro restarted but did not become healthy on http://${host}:${port} in time.`);
    process.exit(1);
  }
  console.log(`[ok] Maestro restarted and is healthy on http://${host}:${port}`);
}

async function dashboardCommand(): Promise<void> {
  console.log("Launching Maestro Dashboard web mode (http://127.0.0.1:4788)...");
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCmd, ["run", "dev:platform"], {
    cwd: process.cwd(),
    stdio: "inherit"
  });
  child.on("close", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function desktopCommand(argv: string[]): Promise<void> {
  const options = parseDesktopCliOptions(argv);
  const paths = resolveDesktopPaths();

  if (options.skipBuild) {
    if (isUiDistMissing(paths.distIndex)) {
      console.error(`[!] UI build missing at ${paths.distIndex}. Run 'maestro desktop' without --skip-build or run 'npm run build:ui' first.`);
      process.exit(1);
    }
  } else {
    if (isUiDistMissing(paths.distIndex) || isUiDistStale(paths.uiDir, paths.distIndex)) {
      console.log("[..] Building dashboard UI (npm run build:ui)...");
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      execFileSync(npmCmd, ["run", "build:ui"], { stdio: "inherit" });
    }
  }

  const isHealthy = await checkApiHealth(options.host, options.port, 1000);
  let childBackend: ReturnType<typeof spawn> | undefined;

  if (!isHealthy) {
    console.log("[..] Orchestrator API server is not running. Starting orchestrator...");
    const cliDir = path.dirname(fileURLToPath(import.meta.url));
    const srcIndex = path.resolve(cliDir, "../index.ts");
    const tsxCli = path.resolve(cliDir, "../../node_modules/tsx/dist/cli.mjs");
    if (!fs.existsSync(tsxCli) || !fs.existsSync(srcIndex)) {
      console.error("[!] Unable to locate orchestrator entry files.");
      process.exit(1);
    }
    childBackend = spawn(process.execPath, [tsxCli, srcIndex], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    let attempts = 0;
    let started = false;
    while (attempts < 60) {
      await new Promise((r) => setTimeout(r, 250));
      if (await checkApiHealth(options.host, options.port, 500)) {
        started = true;
        break;
      }
      attempts++;
    }
    if (!started) {
      console.error("[!] Failed to verify orchestrator API server health.");
      childBackend?.kill();
      process.exit(1);
    }
  } else {
    console.log(`[ok] Orchestrator API server running on http://${options.host}:${options.port}`);
  }

  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const binName = process.platform === "win32" ? "electron.cmd" : "electron";
  const localElectron = path.resolve(cliDir, "../../node_modules/.bin", binName);
  const electronBin = fs.existsSync(localElectron) ? localElectron : (process.platform === "win32" ? "npx.cmd" : "npx");
  const electronArgs = fs.existsSync(localElectron)
    ? [paths.desktopEntry]
    : ["electron", paths.desktopEntry];

  console.log("[..] Launching Maestro Desktop App...");
  const desktopChild = spawn(electronBin, electronArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    // On Windows the local electron/npx bin is a .cmd shim; spawn() of a .cmd
    // without shell:true throws EINVAL, so enable the shell for the spawn.
    ...(process.platform === "win32" ? { shell: true } : {}),
    env: {
      ...process.env,
      MAESTRO_API_PORT: String(options.port),
      MAESTRO_API_HOST: options.host
    }
  });

  desktopChild.on("close", (code) => {
    childBackend?.kill();
    process.exit(code ?? 0);
  });

  const cleanup = () => {
    childBackend?.kill();
    desktopChild.kill();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function statusCommand(): void {
  const cwd = process.cwd();
  const nodeMatch = /v(\d+)\./.exec(process.version);
  const nodeMajor = nodeMatch ? Number(nodeMatch[1]) : 0;

  console.log("maestro status — resumo da instalacao\n");
  console.log("  Runtime");
  console.log(`    Node       : ${process.version}${nodeMajor >= 20 ? " (ok)" : " (requer >= 20)"}`);
  console.log(`    TSX        : ${fs.existsSync(path.join(cwd, "node_modules", "tsx")) ? "presente" : "ausente (npm install)"}`);

  const cliGithub = commandAvailable("gh") ? "disponivel" : "ausente (opcional)";
  const cliClaude = commandAvailable("claude") ? "disponivel" : "ausente";
  const cliCodex = commandAvailable("codex") ? "disponivel" : "ausente";

  console.log("\n  Providers");
  console.log(`    GitHub     : ${cliGithub}`);
  console.log(`    Claude     : ${cliClaude}`);
  console.log(`    Codex      : ${cliCodex}`);

  const envFile = [".env.local", ".env"].map(name => path.join(cwd, name)).find(f => fs.existsSync(f));
  const env = envFile ? fs.readFileSync(envFile, "utf8") : "";
  const hasBot = /^TELEGRAM_BOT_TOKEN=.+/m.test(env);
  const hasUserId = /^TELEGRAM_ALLOWED_USER_ID=.+/m.test(env);
  console.log("\n  Telegram");
  console.log(`    Bot token  : ${hasBot ? "configurado" : "nao configurado"}`);
  console.log(`    User ID    : ${hasUserId ? "restrito" : "livre (todos)"}`);
  if (!hasBot) console.log("    Dica       : maestro telegram connect");

  console.log("\n  Projeto");
  const dbPath = envDbPath();
  const dbExists = fs.existsSync(dbPath);
  console.log(`    Banco local: ${dbExists ? dbPath : "nao inicializado"}`);
}

async function main(): Promise<void> {
  const [, , command, ...argv] = process.argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
      printHelp();
      break;
    case "setup": {
      const result = runConfigWizard();
      console.log(result.summary);
      break;
    }
    case "telegram": {
      const sub = argv[0];
      if (sub === "connect") {
        const result = await runTelegramConnectWizard();
        if (!result.success) {
          console.error(`[!] Nao foi possivel conectar o Telegram: ${result.error ?? "erro desconhecido"}`);
          process.exit(1);
        }
        console.log(`[ok] Bot conectado${result.botInfo ? ` como @${result.botInfo.username}` : ""}.`);
      } else {
        console.error("Usage: maestro telegram connect");
        process.exit(1);
      }
      break;
    }
    case "project":
      if (argv[0] === "add") await projectAddCommand(argv.slice(1));
      else { console.error("Usage: maestro project add <key> <path|github-url>"); process.exit(1); }
      break;
    case "start":
      await startCommand();
      break;
    case "restart":
      await restartCommand(argv);
      break;
    case "dashboard":
      await dashboardCommand();
      break;
    case "desktop":
      await desktopCommand(argv);
      break;
    case "status":
      statusCommand();
      break;
    default:
      console.error(`maestro: comando desconhecido '${command}'`);
      printHelp();
      process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
