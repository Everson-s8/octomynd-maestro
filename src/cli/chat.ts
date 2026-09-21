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
import { createDatabase } from "../db.js";
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

function banner(locale: "pt-BR" | "en"): void {
  console.log(`\n${MAGENTA}${OCTOPUS}${RESET}`);
  console.log(`${DIM}${"─".repeat(46)}${RESET}`);
  console.log(
    locale === "pt-BR"
      ? `${DIM}Chat de trabalho — escreva sua solicitação ou /help. Ctrl+C cancela.${RESET}`
      : `${DIM}Working chat — type your request or /help. Ctrl+C cancels.${RESET}`
  );
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
  const projectKey = argv.includes("--project")
    ? argv[argv.indexOf("--project") + 1]?.toLowerCase()
    : undefined;
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

  const effectiveProject = projectKey ?? inferProject(database);
  if (!effectiveProject) {
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
  rl.setPrompt(`${CYAN}${BOLD}maestro${RESET}${DIM}@${GRAY}${effectiveProject}${RESET}${DIM}›${RESET} `);

  let threadId: number | null = null;
  let turnActive = false;

  const send = async (message: string): Promise<void> => {
    turnActive = true;
    const request: OperationalChatRequest = {
      projectKey: effectiveProject,
      threadId: threadId ?? null,
      surface: "cli",
      message,
      uiLocale: locale,
      accessMode,
    };
    startProgress(locale === "pt-BR" ? "trabalhando…" : "working…");

    // Poll activity while the ask runs so the user sees the loop working.
    const poll = setInterval(() => {
      try {
        const live = threadId == null
          ? service.getActiveChat(effectiveProject)
          : { threadId, activity: service.getActivity(effectiveProject, threadId) };
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
              projectKey: effectiveProject,
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
                projectKey: effectiveProject,
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
          ? "Comandos: /exit sair · /clear limpar · /full alternar Full Access · Ctrl+C cancelar turno"
          : "Commands: /exit quit · /clear clear · /full toggle Full Access · Ctrl+C cancel turn"
      );
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
    service.cancelChat(effectiveProject, threadId);
  });

  rl.on("close", () => {
    stopProgress();
    // Do NOT close the database here: stdin EOF (e.g. a piped script) can fire
    // while a turn is still running, and the OS reclaims the file anyway.
  });

  if (!noBanner) banner(locale);
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
    if (rows.length > 0) return rows[0].key;
    return null;
  } catch {
    const cwd = process.cwd();
    const key = cwd.split(/[\\/]/).pop()?.toLowerCase();
    return key || null;
  }
}
