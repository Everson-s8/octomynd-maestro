#!/usr/bin/env node
/**
 * maestro chat — interactive terminal chat for Maestro.
 *
 * A readline REPL over the same OperationalChatService the dashboard uses,
 * without needing the HTTP server or a browser. Supports:
 *   - project context (cwd project, or --project <key>)
 *   - governed actions with confirmation (Standard mode)
 *   - Full Access mode (--full) that executes without asking
 *   - activity progress while the agent loop works
 *   - cancel (Ctrl+C) during a turn
 *   - history (up/down arrows), the Octomynd octopus, and colors
 *
 * Usage: maestro chat [--project <key>] [--full]
 */
import { createInterface } from "node:readline";
import path from "node:path";
import { createDatabase } from "../db.js";
import type { AgentProviderId, AgentReasoningEffort } from "../agents/types.js";
import { REASONING_EFFORTS } from "../agents/types.js";
import { loadConfig } from "../config.js";
import { createAgentRegistry } from "../agents/runtime.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import {
  OperationalChatService,
  type OperationalChatServiceOptions
} from "../chat/service.js";
import { cliDataDir, envDbPath } from "./env.js";
import type {
  OperationalChatActivity,
  OperationalChatRequest,
  OperationalChatResponse
} from "../chat/types.js";

// ─── ANSI colors (small, no dependency) ───────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const CLEAR_LINE = "\x1b[2K\r";

// ─── Octomynd octopus ─────────────────────────────────────────────────────────
const OCTOPUS = [
  "             _..._",
  "           .'  O  \\",
  "          /   ~    |",
  "         |    O   /",
  "          \\      /",
  "           '.__.'",
  "    __.----'  '----.__",
  "   /  ~  \\      /  ~  \\",
  "  |      |    |      |",
  "   \\  ~  /      \\  ~  /",
  "    '--'          '--'",
  "   / ~ \\          / ~ \\",
  "  |    |         |    |",
  "   \\   /   \\  /   \\   /",
  "    '-'     '--'    '-'"
].join("\n");

function banner(locale: "pt-BR" | "en", projectKey: string): void {
  console.log(`\n${MAGENTA}${OCTOPUS}${RESET}`);
  console.log(`${DIM}${"─".repeat(46)}${RESET}`);
  console.log(
    locale === "pt-BR"
      ? `${DIM}Chat de trabalho — escreva sua solicitação ou /help. Ctrl+C cancela.${RESET}`
      : `${DIM}Working chat — type your request or /help. Ctrl+C cancels.${RESET}`
  );
  console.log(`${DIM}${locale === "pt-BR" ? "Contexto automático" : "Automatic context"}: @${projectKey}${RESET}`);
}

// ─── Progress rendering (single line under the input) ────────────────────────
let progressTimer: ReturnType<typeof setInterval> | null = null;
let lastProgress = "";

function startProgress(initial: string): void {
  stopProgress();
  let i = 0;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  progressTimer = setInterval(() => {
    const frame = frames[i++ % frames.length];
    process.stdout.write(`${CLEAR_LINE}${DIM}${frame} ${lastProgress}${RESET}`);
  }, 120);
  lastProgress = initial;
}

function updateProgress(text: string): void {
  lastProgress = text;
}

function stopProgress(): void {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  if (lastProgress) {
    process.stdout.write(CLEAR_LINE);
    lastProgress = "";
  }
}

/** Map a chat activity snapshot to a human progress line. */
function activityLine(a: OperationalChatActivity | null, locale: "pt-BR" | "en"): string {
  if (!a || !a.active) return locale === "pt-BR" ? "trabalhando…" : "working…";
  switch (a.phase) {
    case "thinking":
      return locale === "pt-BR"
        ? `raciocinando (iteração ${a.iteration}/${a.maxIterations})…`
        : `reasoning (iteration ${a.iteration}/${a.maxIterations})…`;
    case "tool":
      return locale === "pt-BR"
        ? `usando ${a.toolName ?? "ferramenta"} (chamada ${a.toolCalls}/${a.maxToolCalls})…`
        : `using ${a.toolName ?? "tool"} (call ${a.toolCalls}/${a.maxToolCalls})…`;
    default:
      return a.detail || lastProgress;
  }
}

// ─── Locale ───────────────────────────────────────────────────────────────────
function userLocale(): "pt-BR" | "en" {
  const env = process.env.MAESTRO_LANG?.toLowerCase() ?? process.env.LANG?.toLowerCase() ?? "";
  return env.includes("pt") ? "pt-BR" : "en";
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function chatCommand(argv: string[]): Promise<number> {
  const locale = userLocale();
  const projectArgument = optionValue(argv, "--project");
  const projectKey = argv.includes("--project")
    ? normalizeProjectKey(projectArgument)
    : undefined;
  const initialProvider = optionValue(argv, "--provider");
  const initialModel = optionValue(argv, "--model");
  const fullAccess = argv.includes("--full");
  const noBanner = argv.includes("--no-banner");

  const database = createDatabase(envDbPath());
  const config = loadConfig(cliDataDir());
  const commands = new ApplicationCommands(database);
  const agentRegistry = createAgentRegistry(config, database);
  const serviceOptions: OperationalChatServiceOptions = {
    database,
    commands,
    agentRegistry,
    worktreesRoot: config.worktreesPath,
    taskSizer: undefined
  };
  const service = new OperationalChatService(serviceOptions);

  let activeProjectKey: string = projectKey ?? inferProject(database) ?? "";
  if (!activeProjectKey) {
    console.error(
      locale === "pt-BR"
        ? "Nenhum projeto encontrado. Registre um com: maestro project add <chave> <caminho-ou-url>"
        : "No project found. Register one with: maestro project add <key> <path-or-url>"
    );
    database.close();
    return 1;
  }

  const accessMode = fullAccess ? "full" : "standard";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`${CYAN}${BOLD}maestro${RESET}${DIM}›${RESET} `);

  let threadId: number | null = null;
  let turnActive = false;
  let selectedProviderId: AgentProviderId | null = initialProvider as AgentProviderId | null;
  let selectedModel: string | null = initialModel ?? null;
  let selectedEffort: AgentReasoningEffort | null = null;

  const send = async (message: string): Promise<void> => {
    turnActive = true;
    const request: OperationalChatRequest = {
      projectKey: activeProjectKey,
      threadId: threadId ?? null,
      surface: "cli",
      message,
      uiLocale: locale,
      accessMode,
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(selectedEffort ? { effort: selectedEffort } : {})
    };
    startProgress(locale === "pt-BR" ? "trabalhando…" : "working…");

    // Poll activity while the ask runs so the user sees the loop working.
    const poll = setInterval(() => {
      try {
        const live = threadId == null
          ? service.getActiveChat(activeProjectKey)
          : { threadId, activity: service.getActivity(activeProjectKey, threadId) };
        if (live) {
          threadId = live.threadId;
          updateProgress(activityLine(live.activity, locale));
        }
      } catch {
        /* no activity yet — keep the generic line */
      }
    }, 300);

    let response: OperationalChatResponse;
    try {
      response = await service.ask(request);
    } catch (error) {
      clearInterval(poll);
      stopProgress();
      console.log(`\n${RED}${error instanceof Error ? error.message : String(error)}${RESET}`);
      turnActive = false;
      rl.prompt();
      return;
    }
    clearInterval(poll);
    stopProgress();
    threadId = response.threadId;

    // Governed actions: Full executes automatically; Standard asks first.
    if (response.actions.length > 0) {
      for (const action of response.actions) {
        if (fullAccess) {
          try {
            const result = await service.executeAction({
              projectKey: activeProjectKey,
              threadId: response.threadId,
              surface: "cli",
              action,
              uiLocale: locale,
              accessMode,
            });
            console.log(`${GREEN}${BOLD}✓${RESET} ${DIM}${result.resultSummary}${RESET}`);
          } catch (error) {
            console.log(`${RED}${error instanceof Error ? error.message : String(error)}${RESET}`);
          }
        } else {
          console.log(
            `${YELLOW}${BOLD}[ação]${RESET} ${CYAN}${action.label}${RESET} — ${DIM}${action.description ?? ""}${RESET}`
          );
          const answer = await promptYesNo(
            rl,
            locale === "pt-BR" ? "  Executar? (s/N) " : "  Execute? (y/N) "
          );
          if (answer) {
            try {
              const result = await service.executeAction({
                projectKey: activeProjectKey,
                threadId: response.threadId,
                surface: "cli",
                action,
                uiLocale: locale,
                accessMode,
              });
              console.log(`${GREEN}${BOLD}✓${RESET} ${DIM}${result.resultSummary}${RESET}`);
            } catch (error) {
              console.log(`${RED}${error instanceof Error ? error.message : String(error)}${RESET}`);
            }
          }
        }
      }
    }

    // Print the assistant response.
    const text = response.explanation.trim();
    if (text) console.log(`\n${CYAN}${BOLD}octo${RESET} ${text}`);
    const loopStats = response.loopStats;
    if (loopStats && (loopStats.toolCalls > 0 || loopStats.iterations > 1)) {
      console.log(
        `${DIM}${locale === "pt-BR" ? "→ raciocínio" : "→ reasoning"}${RESET} ` +
          `${DIM}${loopStats.iterations} iteração(ões) · ${loopStats.toolCalls} tool call(s) · ` +
          `${loopStats.toolsUsed.join(", ")} · para: ${loopStats.stopReason}${RESET}`
      );
    }
    turnActive = false;
    rl.prompt();
  };

  const onLine = (line: string): void => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "/exit" || input === "/quit" || input === "/sair") {
      if (turnActive) {
        console.log(`${DIM}${locale === "pt-BR" ? "Aguarde o turno terminar ou pressione Ctrl+C para cancelar." : "Wait for the turn to finish or press Ctrl+C to cancel."}${RESET}`);
        rl.prompt();
        return;
      }
      service.shutdown();
      database.close();
      rl.close();
      return;
    }
    if (input === "/help" || input === "/ajuda") {
      console.log(
        locale === "pt-BR"
          ? "Comandos: /projects · /project [chave] · /project_add · /tasks · /providers · /provider · /model · /effort · /context · /exit · /clear · /full · Ctrl+C cancelar"
          : "Commands: /projects · /project [key] · /project_add · /tasks · /providers · /provider · /model · /effort · /context · /exit · /clear · /full · Ctrl+C cancel"
      );
      rl.prompt();
      return;
    }
    if (input === "/providers") {
      void agentRegistry.snapshot().then((providers) => {
        console.log(providers.length === 0
          ? `${DIM}${locale === "pt-BR" ? "Nenhum provider detectado." : "No providers detected."}${RESET}`
          : providers.map((provider) => `${provider.id === selectedProviderId ? "▸" : " "} ${provider.id} — ${provider.state}${provider.currentModel ? ` · ${provider.currentModel}` : ""}`).join("\n"));
        rl.prompt();
      }).catch((error) => {
        console.log(`${RED}${error instanceof Error ? error.message : String(error)}${RESET}`);
        rl.prompt();
      });
      return;
    }
    if (input === "/projects" || input === "/project list") {
      const projects = database.listProjects(100);
      console.log(projects.length === 0
        ? `${DIM}${locale === "pt-BR" ? "Nenhum projeto cadastrado." : "No projects registered."}${RESET}`
        : projects.map((project) => `${project.key === activeProjectKey ? "▸" : " "} @${project.key} — ${project.name} (${project.defaultBranch})`).join("\n"));
      rl.prompt();
      return;
    }
    if (input === "/project" || input.startsWith("/project ")) {
      const requested = normalizeProjectKey(input.split(/\s+/)[1]);
      if (!requested) {
        console.log(`${DIM}${locale === "pt-BR" ? "Projeto ativo" : "Active project"}: @${activeProjectKey}${RESET}`);
      } else {
        const project = database.findProjectByKey(requested);
        if (!project) {
          console.log(`${RED}${locale === "pt-BR" ? `Projeto @${requested} não encontrado.` : `Project @${requested} not found.`}${RESET}`);
        } else {
          activeProjectKey = project.key;
          threadId = null;
          console.log(`${DIM}${locale === "pt-BR" ? "Contexto alterado para" : "Context switched to"}: @${activeProjectKey}${RESET}`);
        }
      }
      rl.prompt();
      return;
    }
    if (input.startsWith("/project_add")) {
      const [, rawKey, ...targetParts] = input.split(/\s+/);
      const target = targetParts.join(" ").trim();
      if (!rawKey || !target) {
        console.log(`${RED}${locale === "pt-BR" ? "Uso: /project_add chave caminho-do-repositorio" : "Usage: /project_add key repository-path"}${RESET}`);
      } else {
        try {
          const result = commands.registerProject({ channel: "cli" }, { key: normalizeProjectKey(rawKey)!, path: target });
          console.log(`${GREEN}${locale === "pt-BR" ? "Projeto cadastrado" : "Project registered"}: @${result.project.key}${RESET}`);
        } catch (error) {
          console.log(`${RED}${error instanceof Error ? error.message : String(error)}${RESET}`);
        }
      }
      rl.prompt();
      return;
    }
    if (input === "/tasks" || input === "/queue") {
      const tasks = database.listTasksByProject(activeProjectKey, 20);
      console.log(tasks.length === 0
        ? `${DIM}${locale === "pt-BR" ? "Nenhuma task recente." : "No recent tasks."}${RESET}`
        : tasks.map((task) => `#${task.id} [${task.status}] ${task.title || task.text}`).join("\n"));
      rl.prompt();
      return;
    }
    if (input === "/context") {
      console.log(`${DIM}${locale === "pt-BR" ? "Contexto ativo" : "Active context"}: @${activeProjectKey}${RESET}`);
      rl.prompt();
      return;
    }
    if (input === "/provider" || input.startsWith("/provider ")) {
      const [, provider] = input.split(/\s+/);
      if (!provider || provider === "auto" || provider === "automatico" || provider === "automático") {
        selectedProviderId = null;
        selectedModel = null;
        console.log(`${DIM}${locale === "pt-BR" ? "Roteamento automático ativado." : "Automatic routing enabled."}${RESET}`);
      } else {
        selectedProviderId = provider as AgentProviderId;
        selectedModel = null;
        console.log(`${DIM}${locale === "pt-BR" ? "Provider selecionado" : "Selected provider"}: ${selectedProviderId}${RESET}`);
      }
      rl.prompt();
      return;
    }
    if (input === "/model" || input.startsWith("/model ")) {
      const model = input.split(/\s+/).slice(1).join(" ").trim();
      selectedModel = !model || model === "auto" || model === "automatico" || model === "automático" ? null : model;
      console.log(`${DIM}${locale === "pt-BR" ? "Modelo" : "Model"}: ${selectedModel ?? "automatico"}${RESET}`);
      rl.prompt();
      return;
    }
    if (input.startsWith("/effort")) {
      const [, effort] = input.split(/\s+/);
      if (!effort || effort === "auto" || effort === "automatico" || effort === "automático") {
        selectedEffort = null;
      } else if (REASONING_EFFORTS.includes(effort as AgentReasoningEffort)) {
        selectedEffort = effort as AgentReasoningEffort;
      } else {
        console.log(`${RED}${locale === "pt-BR" ? `Nível inválido. Use: ${REASONING_EFFORTS.join(", ")}` : `Invalid level. Use: ${REASONING_EFFORTS.join(", ")}`}${RESET}`);
        rl.prompt();
        return;
      }
      console.log(`${DIM}${locale === "pt-BR" ? "Esforço" : "Effort"}: ${selectedEffort ?? "automatico"}${RESET}`);
      rl.prompt();
      return;
    }
    if (input === "/full") {
      console.log(
        locale === "pt-BR"
          ? "Este chat usa o modo definido ao abrir. Saia e rode: maestro chat --full"
          : "This chat uses the mode from launch. Exit and run: maestro chat --full"
      );
      rl.prompt();
      return;
    }
    if (input === "/clear") {
      console.clear();
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      console.log(`${RED}${locale === "pt-BR" ? "Comando desconhecido" : "Unknown command"}${RESET}`);
      rl.prompt();
      return;
    }
    if (turnActive) {
      console.log(`${DIM}${locale === "pt-BR" ? "Aguarde o turno atual terminar." : "Wait for the current turn to finish."}${RESET}`);
      rl.prompt();
      return;
    }
    void send(input);
  };

  rl.on("line", onLine);
  rl.on("SIGINT", () => {
    if (!turnActive) {
      // Idle: a second Ctrl+C exits cleanly.
      if (rl.line.length === 0) {
        service.shutdown();
        database.close();
        rl.close();
        return;
      }
      // Still typing on the prompt line — just cancel the input and give a fresh prompt.
      rl.write("", { ctrl: true, name: "u" });
      rl.prompt();
      return;
    }
    // Mid-turn: cancel the in-flight ask, keep the REPL alive.
    stopProgress();
    console.log(
      `\n${DIM}${locale === "pt-BR" ? "cancelando…" : "cancelling…"}${RESET}`
    );
    service.cancelChat(activeProjectKey, threadId);
  });

  rl.on("close", () => {
    stopProgress();
    // Do NOT close the database here: stdin EOF (e.g. a piped script) can fire
    // while a turn is still running, and the OS reclaims the file anyway.
  });

  if (!noBanner) banner(locale, activeProjectKey);
  rl.prompt();
  return 0;
}

function promptYesNo(rl: ReturnType<typeof createInterface>, question: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase().startsWith("s") || answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

// ─── Pragmatic project inference from the DB ─────────────────────────────────
function inferProject(database: ReturnType<typeof createDatabase>): string | null {
  try {
    const rows = database.listProjects?.() ?? [];
    const cwd = path.resolve(process.cwd());
    const matching = rows.find((project) => {
      const root = path.resolve(project.path);
      return cwd === root || cwd.startsWith(`${root}${path.sep}`);
    });
    if (matching) return matching.key;
    if (rows.length > 0) return rows[0].key;
    return null;
  } catch {
    const cwd = process.cwd();
    const key = cwd.split(/[\\/]/).pop()?.toLowerCase();
    return key || null;
  }
}

function optionValue(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1]?.trim() || undefined : undefined;
}

function normalizeProjectKey(value: string | undefined): string | undefined {
  return value?.replaceAll("\\_", "_").replace(/^@+/, "").toLowerCase();
}
