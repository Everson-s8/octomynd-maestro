#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawn } from "node:child_process";
import { runConfigWizard } from "../config/wizard.js";
import { runTelegramConnectWizard } from "../telegram/connect.js";
import { createDatabase } from "../db.js";
import type { ProjectRecord, TaskRecord } from "../db.js";
import { loadConfig } from "../config.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { CommandOrigin } from "../commands/types.js";
import { PROVIDER_PRESETS } from "../agents/provider-config.js";
import { ProviderAuthBroker } from "../agents/provider-auth.js";
import {
  resolveDesktopPaths,
  parseDesktopCliOptions,
  isUiDistMissing,
  isUiDistStale,
  checkApiHealth
} from "../desktop/launcher.js";
import { findProcessOnPort, killProcessGracefully } from "../runtime/port-process.js";
import { detectGitDefaultBranch } from "../git.js";
import { requestDashboardJson } from "./dashboard-client.js";

function cliOrigin(): CommandOrigin {
  return { channel: "maestro" };
}

function cliDataDir(): string {
  return path.resolve(process.env.MAESTRO_DATA_DIR?.trim() || process.cwd());
}

function isPackagedCli(): boolean {
  return process.env.MAESTRO_CLI_MODE === "packaged";
}

function resolveOrchestratorEntry(): string | null {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(cliDir, "../index.js"), path.resolve(cliDir, "../index.ts")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

type OrchestratorLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

function buildOrchestratorLaunch(): OrchestratorLaunch | null {
  const entry = resolveOrchestratorEntry();
  if (!entry) return null;

  const packaged = isPackagedCli();
  if (entry.endsWith(".js") && packaged) {
    return {
      command: process.execPath,
      args: [entry],
      cwd: cliDataDir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MAESTRO_REQUIRE_TELEGRAM: "false",
        MAESTRO_RUNTIME_MODE: "packaged",
        MAESTRO_RUNTIME_ROOT: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
      }
    };
  }

  if (entry.endsWith(".js")) {
    return {
      command: process.execPath,
      args: [entry],
      cwd: process.cwd(),
      env: { ...process.env }
    };
  }

  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const tsxCli = path.resolve(cliDir, "../../node_modules/tsx/dist/cli.mjs");
  if (!fs.existsSync(tsxCli)) return null;
  return {
    command: process.execPath,
    args: [tsxCli, entry],
    cwd: process.cwd(),
    env: { ...process.env }
  };
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
  return path.resolve(cliDataDir(), configured ?? ".maestro/maestro.db");
}

function printHelp(): void {
  console.log(`maestro — Octomynd Maestro CLI

Usage: maestro <command> [options]

Commands:
  setup                 Run the interactive configuration wizard (providers, GitHub).
  telegram connect      Connect your Telegram bot (token from @BotFather).
  project add <key> <path|github-url>
                        Register a local Git project, or clone a GitHub URL and register it.
  project list [--limit N]
                        List projects registered in the same database as the dashboard.
  task create <project> <text>
                        Queue a task through the shared application command layer.
  task list [--project K] [--limit N]
                        List tasks using the same records shown by the dashboard.
  task prepare <id>     Create the deterministic worktree for a queued task.
  task start <id> [--max-steps N]
                        Start a Goal through the dashboard API.
  task cancel <id>      Cancel a running Goal through the dashboard API.
  task retry <id>       Retry a task through the dashboard API.
  task delete <id>      Delete a queued/cancelled task through the dashboard API.
  task logs <id> [--follow] [--limit N]
                        Inspect persisted task activity in the terminal.
  task followup <id> <text>
                        Create a queued follow-up linked to an existing task.
  start                 Launch the Maestro orchestrator (dashboard UI + API + workers).
  restart [--port N] [--host H]
                        Restart a running Maestro process on the current code.
  dashboard             Launch the web dashboard UI (http://127.0.0.1:4788).
  logs <task-id> [--follow] [--limit N]
                        Inspect persisted task activity in the terminal.
  followup <task-id> <text>
                        Create a queued follow-up task linked to an existing task.
  quota                 Read provider quota through the running dashboard runtime.
  providers status      Show live provider health and routing controls.
  doctor [project-key]  Inspect project readiness through the running dashboard.
  desktop [--skip-build]
                        Launch Maestro as a native desktop app (Electron).
  status                Show what is installed, connected, and ready.
  providers login <id>  Log in to an account provider (codex, claude, gemini, ...)
                        via its official CLI; prints the verification code and
                        opens the provider's page, then waits for you to finish.
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
      console.log(`[..] Cloning https://github.com/${repo} into ${dest}`);
      const url = `https://github.com/${repo}`;
      execFileSync("git", ["clone", url, dest], { stdio: "inherit" });
    }
    projectPath = dest;
  }

  if (!fs.existsSync(command_path_dir(projectPath))) {
    console.error(`[!] Path not found: ${projectPath}`);
    process.exit(1);
  }

  const dbPath = envDbPath();
  const database = createDatabase(dbPath);
  const commands = new ApplicationCommands(database);

  try {
      const detectedBranch = detectGitDefaultBranch(projectPath);
      const result = commands.registerProject(cliOrigin(), {
        key,
        path: projectPath,
        defaultBranch: detectedBranch ?? undefined
      });
    for (const warning of result.warnings) console.log(`[~] ${warning}`);
    console.log(`[ok] Project @${key} registered at ${result.project.path}`);
  } catch (error) {
    console.error(`[!] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function command_path_dir(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function parseLimit(argv: string[], fallback = 20): number {
  const index = argv.indexOf("--limit");
  const value = index >= 0 ? Number(argv[index + 1]) : fallback;
  return Number.isInteger(value) ? Math.min(500, Math.max(1, value)) : fallback;
}

function parseTaskId(value: string | undefined, usage: string): number {
  const taskId = Number(value);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error(`Usage: ${usage}`);
  }
  return taskId;
}

function printProject(project: ProjectRecord): void {
  console.log(`  @${project.key}  ${project.name}  (${project.defaultBranch})`);
  console.log(`      ${project.path}`);
  console.log(`      sync=${project.syncState ?? "unknown"} canonical=${shortSha(project.canonicalHeadSha)} remote=${shortSha(project.remoteHeadSha)}`);
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "n/a";
}

function printTask(task: TaskRecord): void {
  const project = task.projectKey ? `@${task.projectKey}` : "inbox";
  const worktree = task.worktreePath ? " worktree=prepared" : "";
  console.log(`  #${task.id}  ${task.status.padEnd(18)} ${project}${worktree}`);
  console.log(`      ${task.title || task.text}`);
  if (task.title && task.title !== task.text) console.log(`      Original request: ${task.text}`);
}

function projectListCommand(argv: string[]): void {
  const database = createDatabase(envDbPath());
  try {
    const projects = database.listProjects(parseLimit(argv));
    console.log(`maestro project list — ${projects.length} project(s)\n`);
    if (projects.length === 0) console.log("  No projects registered.");
    for (const project of projects) printProject(project);
  } finally {
    database.close();
  }
}

function taskCreateCommand(argv: string[]): void {
  const projectKey = argv[0]?.trim();
  const text = argv.slice(1).join(" ").trim();
  if (!projectKey || !text) throw new Error("Usage: maestro task create <project> <text>");

  const database = createDatabase(envDbPath());
  try {
    const task = new ApplicationCommands(database).createTask(cliOrigin(), { projectKey, text });
    console.log(`[ok] Task #${task.id} created in @${task.projectKey}.`);
    printTask(task);
  } finally {
    database.close();
  }
}

function taskListCommand(argv: string[]): void {
  const projectIndex = argv.indexOf("--project");
  const projectKey = projectIndex >= 0 ? argv[projectIndex + 1]?.trim().toLowerCase() : "";
  const database = createDatabase(envDbPath());
  try {
    const tasks = projectKey
      ? database.listTasksByProject(projectKey, parseLimit(argv))
      : database.listTasks(parseLimit(argv));
    console.log(`maestro task list${projectKey ? ` — @${projectKey}` : ""} — ${tasks.length} task(s)\n`);
    if (tasks.length === 0) console.log("  No tasks found.");
    for (const task of tasks) printTask(task);
  } finally {
    database.close();
  }
}

function taskPrepareCommand(argv: string[]): void {
  const taskId = parseTaskId(argv[0], "maestro task prepare <id>");
  const database = createDatabase(envDbPath());
  try {
    const config = loadConfig(cliDataDir());
    const result = new ApplicationCommands(database).prepareTask(cliOrigin(), taskId, config.worktreesPath);
    console.log(`[ok] Task #${result.task.id} prepared.`);
    console.log(`    Branch  : ${result.branchName}`);
    console.log(`    Worktree: ${result.worktreePath}`);
  } finally {
    database.close();
  }
}

async function taskRuntimeCommand(operation: "start" | "cancel" | "retry" | "delete", argv: string[]): Promise<void> {
  const taskId = parseTaskId(argv[0], `maestro task ${operation} <id>`);
  let payload: { task?: TaskRecord; run?: Record<string, unknown>; goal?: Record<string, unknown> };
  if (operation === "start") {
    const maxStepsIndex = argv.indexOf("--max-steps");
    const requested = maxStepsIndex >= 0 ? Number(argv[maxStepsIndex + 1]) : 12;
    const maxSteps = Number.isInteger(requested) ? Math.min(30, Math.max(4, requested)) : 12;
    payload = await requestDashboardJson(`/api/tasks/${taskId}/goal`, {
      method: "POST",
      body: JSON.stringify({ maxSteps })
    });
    console.log(`[ok] Goal for task #${taskId} started (up to ${maxSteps} steps).`);
    if (payload.run) console.log(`    Run: #${String(payload.run.id ?? "?")} ${String(payload.run.status ?? "")}`);
    return;
  }

  const method = operation === "delete" ? "DELETE" : "POST";
  const endpoint = operation === "delete"
    ? `/api/tasks/${taskId}`
    : `/api/tasks/${taskId}/${operation}`;
  payload = await requestDashboardJson(endpoint, { method });
  if (operation === "retry") {
    console.log(`[ok] Retry requested for task #${taskId}.`);
    if (payload.goal) console.log(`    Run: #${String(payload.goal.id ?? "?")} ${String(payload.goal.status ?? "")}`);
  } else if (operation === "delete") {
    console.log(`[ok] Task #${taskId} deleted.`);
  } else {
    console.log(`[ok] Task #${taskId} cancelled.`);
    if (payload.task) console.log(`    Status: ${payload.task.status}`);
  }
}

type QuotaCliResult = {
  provider: string;
  status: string;
  buckets?: Array<{
    windowKind?: string;
    usedPercent?: number | null;
    remainingPercent?: number | null;
    resetsAt?: string | null;
    planType?: string | null;
  }>;
  error?: string | null;
  stale?: boolean;
};

async function quotaCommand(): Promise<void> {
  const payload = await requestDashboardJson<{ quota?: QuotaCliResult[] }>("/api/quota", {}, { timeoutMs: 20_000 });
  const results = payload.quota ?? [];
  console.log(`maestro quota — ${results.length} provider(s)\n`);
  for (const result of results) {
    const suffix = result.stale ? " (ultima leitura)" : "";
    console.log(`  ${result.provider}: ${result.status}${suffix}`);
    if (result.buckets?.length) {
      for (const bucket of result.buckets) {
        const used = bucket.usedPercent == null ? "?" : `${bucket.usedPercent}%`;
        const remaining = bucket.remainingPercent == null ? "?" : `${bucket.remainingPercent}%`;
        const reset = bucket.resetsAt ? ` reset=${bucket.resetsAt}` : "";
        console.log(`      ${bucket.windowKind ?? "window"}: usado=${used} restante=${remaining}${reset}`);
      }
    } else if (result.error) {
      console.log(`      ${result.error}`);
    }
  }
}

type DashboardAgent = { id: string; label: string; state: string; detail: string; phase?: string };

async function providersStatusCommand(): Promise<void> {
  const payload = await requestDashboardJson<{ agents?: DashboardAgent[]; summary?: { providersConnected?: number } }>("/api/dashboard");
  const agents = (payload.agents ?? []).filter((agent) => agent.id !== "telegram");
  console.log(`maestro providers status — ${payload.summary?.providersConnected ?? agents.length} active\n`);
  if (agents.length === 0) {
    console.log("  No providers registered in the runtime.");
    return;
  }
  for (const agent of agents) {
    console.log(`  ${agent.id.padEnd(16)} ${agent.state.padEnd(10)} ${agent.detail}`);
  }
}

async function doctorCommand(argv: string[]): Promise<void> {
  const projectKey = argv[0]?.trim();
  const endpoint = projectKey
    ? `/api/environment/doctor?projectKey=${encodeURIComponent(projectKey)}`
    : "/api/environment/doctor";
  const payload = await requestDashboardJson<{ report: {
    projectKey: string;
    status: string;
    summary: string;
    recommendedAction: string;
    checks: Array<{ name: string; status: string; summary: string }>;
  } }>(endpoint);
  const report = payload.report;
  console.log(`maestro doctor — @${report.projectKey}: ${report.status}\n`);
  for (const check of report.checks) console.log(`  ${check.status.padEnd(7)} ${check.name}: ${check.summary}`);
  console.log(`\n  Acao: ${report.recommendedAction}`);
}

async function startCommand(): Promise<void> {
  const launch = buildOrchestratorLaunch();
  if (!launch) {
    console.error("[!] Orchestrator runtime files are unavailable. Reinstall Maestro or run npm install in the checkout.");
    process.exit(1);
  }
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
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

  const launch = buildOrchestratorLaunch();
  if (!launch) {
    console.error("[!] Unable to locate orchestrator entry files.");
    process.exit(1);
  }

  console.log("[..] Relaunching Maestro on the current code...");
  const relaunchEnv: NodeJS.ProcessEnv = { ...launch.env };
  // Propagate a non-default port/host so the relaunched process boots on the
  // same endpoint the health check polls (the orchestrator reads these from env).
  if (port !== 4787) relaunchEnv.MAESTRO_DASHBOARD_PORT = String(port);
  if (host !== "127.0.0.1") relaunchEnv.MAESTRO_DASHBOARD_HOST = host;
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
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
  if (isPackagedCli()) {
    await desktopCommand([]);
    return;
  }
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
  if (isPackagedCli()) {
    const desktopEnv = { ...process.env };
    delete desktopEnv.ELECTRON_RUN_AS_NODE;
    const desktopChild = spawn(process.execPath, [], {
      cwd: cliDataDir(),
      env: desktopEnv,
      stdio: "inherit",
      windowsHide: false
    });
    desktopChild.on("close", (code) => process.exit(code ?? 0));
    return;
  }

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

async function statusCommand(): Promise<void> {
  const cwd = process.cwd();
  const configRoot = cliDataDir();
  const nodeMatch = /v(\d+)\./.exec(process.version);
  const nodeMajor = nodeMatch ? Number(nodeMatch[1]) : 0;

  console.log("maestro status — installation summary\n");
  console.log("  Runtime");
  console.log(`    Node       : ${process.version}${nodeMajor >= 20 ? " (ok)" : " (requer >= 20)"}`);
  const runtimeLabel = isPackagedCli()
    ? "embedded in the app"
    : (fs.existsSync(path.join(cwd, "node_modules", "tsx")) ? "present" : "missing (npm install)");
  console.log(`    Runtime CLI: ${runtimeLabel}`);

  const cliGithub = commandAvailable("gh") ? "available" : "missing (optional)";
  const cliClaude = commandAvailable("claude") ? "available" : "missing";
  const cliCodex = commandAvailable("codex") ? "available" : "missing";

  console.log("\n  Providers");
  console.log(`    GitHub     : ${cliGithub}`);
  console.log(`    Claude     : ${cliClaude}`);
  console.log(`    Codex      : ${cliCodex}`);

  const envFile = [".env.local", ".env"]
    .map(name => path.join(configRoot, name))
    .find(f => fs.existsSync(f));
  const env = envFile ? fs.readFileSync(envFile, "utf8") : "";
  const hasBot = /^TELEGRAM_BOT_TOKEN=.+/m.test(env);
  const hasUserId = /^TELEGRAM_ALLOWED_USER_ID=.+/m.test(env);
  console.log("\n  Telegram");
  console.log(`    Bot token  : ${hasBot ? "configured" : "not configured"}`);
  console.log(`    User ID    : ${hasUserId ? "restricted" : "open (everyone)"}`);
  if (!hasBot) console.log("    Tip        : maestro telegram connect");

  console.log("\n  Project");
  const dbPath = envDbPath();
  const dbExists = fs.existsSync(dbPath);
  console.log(`    Local database: ${dbExists ? dbPath : "not initialized"}`);

  const apiHost = process.env.MAESTRO_DASHBOARD_HOST?.trim() || "127.0.0.1";
  const apiPort = Number.parseInt(process.env.MAESTRO_DASHBOARD_PORT ?? "4787", 10) || 4787;
  const apiOnline = await checkApiHealth(apiHost, apiPort, 1_000);
  console.log("\n  Dashboard");
  console.log(`    API        : ${apiOnline ? `online (http://${apiHost}:${apiPort})` : "offline"}`);
}

function renderTaskLogs(taskId: number, limit: number): void {
  const database = createDatabase(envDbPath());
  const logs = database.getTaskLogs(taskId);
  console.clear();
  console.log(`maestro logs — Task #${logs.task.id}`);
  console.log(`  Project : @${logs.task.projectKey ?? "inbox"}`);
  console.log(`  Status  : ${logs.task.status}`);
  console.log(`  Request : ${logs.task.text}`);
  if (logs.task.parentTaskId) console.log(`  Origin  : follow-up from task #${logs.task.parentTaskId}`);
  console.log("\nEvents:");
  for (const event of logs.events.slice(-limit)) {
    console.log(`  ${event.createdAt}  ${event.type}  ${event.text}`);
  }
  console.log("\nRuns:");
  for (const run of logs.runs.slice(-limit)) {
    const outcome = run.lastError
      ?? (run.pullRequestUrl ? `PR ${run.pullRequestUrl}` : null)
      ?? (run.commitSha ? `commit ${run.commitSha}` : "no recorded result");
    console.log(`  #${run.id} ${run.status} ${run.currentPhase ?? ""} — ${outcome}`);
  }
  database.close();
}

async function followUpCommand(argv: string[]): Promise<void> {
  const parentTaskId = Number(argv[0]);
  const text = argv.slice(1).join(" ").trim();
  if (!Number.isInteger(parentTaskId) || parentTaskId <= 0 || !text) {
    console.error("Usage: maestro followup <task-id> <text>");
    process.exit(1);
  }

  const database = createDatabase(envDbPath());
  try {
    const task = new ApplicationCommands(database).createFollowUpTask(cliOrigin(), {
      parentTaskId,
      text
    });
    console.log(`[ok] Task #${task.id} created as a follow-up to task #${parentTaskId}.`);
    console.log(`    Project : @${task.projectKey ?? "inbox"}`);
    console.log(`    Status  : ${task.status}`);
    console.log(`    Request : ${task.text}`);
  } catch (error) {
    console.error(`[!] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    database.close();
  }
}

async function logsCommand(argv: string[]): Promise<void> {
  const taskId = Number(argv[0]);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    console.error("Usage: maestro logs <task-id> [--follow] [--limit N]");
    process.exit(1);
  }
  const limitIndex = argv.indexOf("--limit");
  const requestedLimit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 20;
  const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 20;
  const follow = argv.includes("--follow");
  if (!follow) {
    renderTaskLogs(taskId, limit);
    return;
  }
  console.log("Following logs; press Ctrl+C to exit.");
  while (true) {
    try {
      renderTaskLogs(taskId, limit);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    await sleep(3000);
  }
}

/** Sleep helper for polling. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `maestro providers login <id>`
 *
 * Headless account login for a provider whose official CLI supports an
 * auth flow (device-code or terminal). Reuses the same ProviderAuthBroker the
 * dashboard uses, so a CLI-only user gets identical behaviour: start the flow,
 * print the verification code (if any), open the provider's page, poll until
 * the account is connected.
 */
async function providersLoginCommand(argv: string[]): Promise<void> {
  const providerId = argv[0];
  if (!providerId) {
    console.error("Usage: maestro providers login <id>");
    console.error("Providers with account login: codex, claude, gemini, copilot");
    process.exit(1);
  }
  const preset = PROVIDER_PRESETS.find((item) => item.id === providerId);
  if (!preset) {
    console.error(`maestro: provider '${providerId}' not found.`);
    console.error(`Available: ${PROVIDER_PRESETS.filter((p) => p.authFlow && p.authFlow !== "none").map((p) => p.id).join(", ")}`);
    process.exit(1);
  }
  if (!preset.authFlow || preset.authFlow === "none") {
    console.error(`maestro: provider '${providerId}' does not support account login (use API key or endpoint mode).`);
    process.exit(1);
  }

  const broker = new ProviderAuthBroker();
  console.log(`\n[maestro] Starting ${preset.label} login (${preset.authFlow})...`);
  let session;
  try {
    session = broker.start(preset);
  } catch (error) {
    console.error(`[!] Unable to start login: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Poll until connected/failed/cancelled (up to ~10 min).
  const deadline = Date.now() + 10 * 60_000;
  let lastDetail = "";
  while (Date.now() < deadline) {
    await sleep(1_500);
    const current = broker.get(session.id);
    if (!current) break;
    if (current.verificationUrl) console.log(`    Verification page: ${current.verificationUrl}`);
    if (current.userCode) console.log(`    Verification code : ${current.userCode}`);
    if (current.detail && current.detail !== lastDetail) {
      console.log(`    ${current.detail}`);
      lastDetail = current.detail;
    }
    if (current.state === "connected") {
      console.log(`\n[ok] ${preset.label} connected.`);
      console.log("Tip: run 'maestro start' and open Providers in the dashboard to set priorities.");
      process.exit(0);
    }
    if (current.state === "failed" || current.state === "cancelled") {
      console.error(`\n[!] Login ${current.state}: ${current.detail}`);
      process.exit(1);
    }
  }
  console.error("\n[!] Login did not complete within 10 minutes. Try again.");
  try { broker.cancel(session.id); } catch { /* ignore */ }
  process.exit(1);
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
      const result = runConfigWizard({ cwd: cliDataDir() });
      console.log(result.summary);
      break;
    }
    case "telegram": {
      const sub = argv[0];
      if (sub === "connect") {
        const result = await runTelegramConnectWizard({ cwd: cliDataDir() });
        if (!result.success) {
          console.error(`[!] Unable to connect Telegram: ${result.error ?? "unknown error"}`);
          process.exit(1);
        }
        console.log(`[ok] Bot connected${result.botInfo ? ` as @${result.botInfo.username}` : ""}.`);
      } else {
        console.error("Usage: maestro telegram connect");
        process.exit(1);
      }
      break;
    }
    case "project":
      if (argv[0] === "add") await projectAddCommand(argv.slice(1));
      else if (argv[0] === "list") projectListCommand(argv.slice(1));
      else { console.error("Usage: maestro project add <key> <path|github-url> | maestro project list"); process.exit(1); }
      break;
    case "task": {
      const subcommand = argv[0];
      const taskArgs = argv.slice(1);
      if (subcommand === "create") taskCreateCommand(taskArgs);
      else if (subcommand === "list") taskListCommand(taskArgs);
      else if (subcommand === "prepare") taskPrepareCommand(taskArgs);
      else if (subcommand === "start" || subcommand === "cancel" || subcommand === "retry" || subcommand === "delete") {
        await taskRuntimeCommand(subcommand, taskArgs);
      } else if (subcommand === "logs") await logsCommand(taskArgs);
      else if (subcommand === "followup") await followUpCommand(taskArgs);
      else {
        console.error("Usage: maestro task <create|list|prepare|start|cancel|retry|delete|logs|followup> ...");
        process.exit(1);
      }
      break;
    }
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
      await statusCommand();
      break;
    case "logs":
      await logsCommand(argv);
      break;
    case "followup":
      await followUpCommand(argv);
      break;
    case "quota":
      await quotaCommand();
      break;
    case "doctor":
      await doctorCommand(argv);
      break;
    case "providers":
      if (argv[0] === "login") await providersLoginCommand(argv.slice(1));
      else if (argv[0] === "status") await providersStatusCommand();
      else { console.error("Usage: maestro providers login <id> | maestro providers status"); process.exit(1); }
      break;
    default:
      console.error(`maestro: unknown command '${command}'`);
      printHelp();
      process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
