import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import type { ChatAccessMode } from "./types.js";

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LENGTH = 12_000;
const SAFE_NPM_SCRIPTS = new Set(["test", "typecheck", "typecheck:ui", "build:ui", "lint"]);
const SAFE_GIT_COMMANDS = new Set(["status", "diff", "log", "branch", "show"]);
const SAFE_GH_COMMANDS = new Set(["pr", "run", "issue"]);
const BLOCKED_SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh", "fish"]);
const COMMAND_NAME = /^[a-z][a-z0-9._-]*$/i;
const DIRECT_EXECUTABLES = "npm|pnpm|yarn|bun|npx|uv|git|gh|node|python|python3|py|ruby|go|cargo|vite|next|webpack";

export type ChatCommandEvidence = {
  requested: string;
  command: string;
  status: "completed" | "failed" | "blocked" | "pending";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  detail: string | null;
  pendingId?: string;
  approvalExpiresAt?: string;
};

export type ChatCommandPlan = {
  requested: string;
  executable: string | null;
  args: string[];
  displayCommand: string;
  standardAllowed: boolean;
  blockedReason?: string;
};

export function planProjectStartCommand(projectRoot: string, accessMode: ChatAccessMode): ChatCommandPlan {
  let script = "start";
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = packageJson.scripts ?? {};
    script = ["dev", "start", "serve", "preview"].find((candidate) => typeof scripts[candidate] === "string") ?? "start";
  } catch {
    // The command will return a real failure if the project has no package
    // manifest; do not claim that a server was started from inference alone.
  }
  return planChatCommand(`npm run ${script}`, accessMode) ?? blockedPlan(
    "start project",
    `npm run ${script}`,
    "The project start command could not be planned safely."
  );
}

export function planDependencyInstallCommand(projectRoot: string, accessMode: ChatAccessMode): ChatCommandPlan {
  const manager = fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(projectRoot, "yarn.lock"))
      ? "yarn"
      : fs.existsSync(path.join(projectRoot, "bun.lockb")) || fs.existsSync(path.join(projectRoot, "bun.lock"))
        ? "bun"
        : "npm";
  return planChatCommand(`${manager} install`, accessMode) ?? blockedPlan(
    "install dependencies",
    `${manager} install`,
    "Dependencies could not be planned safely."
  );
}

export function isLongRunningCommand(plan: ChatCommandPlan): boolean {
  if (plan.executable?.replace(/\.cmd$/i, "") !== "npm") return false;
  const script = plan.args[0] === "run" ? plan.args[1] : plan.args[0];
  return script === "start" || script === "dev" || script === "serve" || script === "preview";
}

/**
 * Turns only explicit, allow-listed chat requests into argv. It intentionally
 * does not interpret a shell expression: pipes, redirects, substitutions and
 * working-directory flags are rejected before a child process is spawned.
 */
export function planChatCommand(message: string, accessMode: ChatAccessMode = "standard"): ChatCommandPlan | null {
  const requested = message.trim();
  if (!requested) return null;

  const explicit = requested.match(/^(?:\/run|\/exec|run|execute|executar|execute|rode|rodar|executa)\s+(?:o\s+comando\s+)?(.+)$/i);
  const direct = requested.match(new RegExp(`^(${DIRECT_EXECUTABLES})(?:\\s+|$)(.*)$`, "i"));
  const embedded = requested.match(new RegExp(`\\b(${DIRECT_EXECUTABLES})\\b(?:\\s+.*)?$`, "i"));
  const natural = requested.match(/^(?:rode|rodar|executa|execute|run)\s+(?:os?\s+)?(testes?|tests?|typecheck|build|lint)(?:\s+do\s+projeto)?\s*[.!]?$/i);
  const embeddedPrefix = embedded && requested.slice(0, embedded.index).trim();
  const isEmbeddedExplicitRequest = Boolean(
    embedded && embeddedPrefix && /\b(?:quero|preciso|pode|pod[eê]|execute|executar|executa|run|start|iniciar|inicie|inicia|rodar|rode|roda|dar|d[eê]|faca|fa[cç]a|mande|mandar)\b/i.test(embeddedPrefix)
  );
  const embeddedCommand = isEmbeddedExplicitRequest
    ? requested.slice(embedded?.index ?? 0).replace(/\s+(?:para mim|por favor|please)\s*[.!?]?$/i, "").trim()
    : null;
  const commandText = natural ? naturalCommand(natural[1]) : explicit?.[1]?.trim() ?? direct?.[0]?.trim() ?? embeddedCommand;
  if (!commandText) return null;

  if (/[\r\n;|&<>`$()]/.test(commandText)) {
    return blockedPlan(requested, commandText, "Shell operators are not allowed. Send one supported command at a time.");
  }

  const tokens = tokenize(commandText);
  if (!tokens || tokens.length === 0) return blockedPlan(requested, commandText, "The command could not be parsed safely.");
  const executable = tokens[0].toLowerCase();
  const args = tokens.slice(1);
  const validation = validateCommand(executable, args, accessMode === "standard" || accessMode === "read_only");
  if (validation) return blockedPlan(requested, commandText, validation);

  const resolvedExecutable = process.platform === "win32" && ["npm", "pnpm", "yarn", "bun", "npx", "gh"].includes(executable)
    ? `${executable}.cmd`
    : executable;
  return {
    requested,
    executable: resolvedExecutable,
    args,
    displayCommand: [executable, ...args].join(" "),
    standardAllowed: validateCommand(executable, args, true) === null
  };
}

export async function executeChatCommand(
  plan: ChatCommandPlan,
  projectRoot: string,
  accessMode: ChatAccessMode,
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<ChatCommandEvidence> {
  if (plan.blockedReason) return blockedEvidence(plan);
  if (accessMode === "read_only") {
    return blockedEvidence(plan, "Chat is read-only; switch to Standard or Full Access before running a command.");
  }
  if (accessMode === "standard" && !plan.standardAllowed) {
    return blockedEvidence(plan, "This command is outside Standard access. Switch to Approval or Full Access.");
  }
  if (accessMode === "approval") {
    return pendingEvidence(plan, "This command is waiting for explicit approval before execution.");
  }
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    return blockedEvidence(plan, "A registered project is required before running a command.");
  }

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(plan.executable!, plan.args, {
      cwd: projectRoot,
      // Windows exposes npm/pnpm/yarn/bun through .cmd shims. Node requires
      // the shell for those shims; the command parser has already rejected
      // shell operators and substitutions before this point.
      shell: process.platform === "win32" && plan.executable!.toLowerCase().endsWith(".cmd"),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer | string) => `${current}${chunk.toString()}`.slice(0, MAX_OUTPUT_LENGTH + 1);
    const finish = (status: ChatCommandEvidence["status"], exitCode: number | null, detail: string | null) => {
      if (settled) return;
      settled = true;
      resolve({
        requested: plan.requested,
        command: plan.displayCommand,
        status,
        exitCode,
        stdout: safeOutput(stdout),
        stderr: safeOutput(stderr),
        durationMs: Date.now() - startedAt,
        detail: detail ? redactSensitiveText(truncateForDisplay(detail, 2_000)) : null
      });
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill();
      finish("failed", null, `Command timed out after ${timeoutMs} ms.`);
    }, timeoutMs);
    const abort = () => {
      child.kill();
      clearTimeout(timeout);
      finish("failed", null, "Command cancelled by the user.");
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      finish("failed", null, error.message);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      finish(code === 0 ? "completed" : "failed", code, code === 0 ? null : `Command exited with code ${code ?? "unknown"}.`);
    });
  });
}

export function formatChatCommandEvidence(evidence: ChatCommandEvidence, locale: "en" | "pt-BR"): string {
  const heading = locale === "pt-BR" ? "Resultado real do comando" : "Actual command result";
  const status = locale === "pt-BR"
    ? `${evidence.status === "completed" ? "concluído" : evidence.status === "failed" ? "falhou" : evidence.status === "pending" ? "aguardando aprovação" : "bloqueado"}`
    : evidence.status;
  const output = [evidence.stdout, evidence.stderr ? `stderr:\n${evidence.stderr}` : ""].filter(Boolean).join("\n").trim() || "(no output)";
  const detail = evidence.detail ? `\n${evidence.detail}` : "";
  return `${heading}: \`${evidence.command}\` — ${status}${evidence.exitCode === null ? "" : ` (exit ${evidence.exitCode})`}${detail}\n\n\`\`\`text\n${output}\n\`\`\``;
}

function naturalCommand(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("test") || normalized.startsWith("testes")) return "npm test";
  if (normalized === "typecheck") return "npm run typecheck";
  if (normalized === "build") return "npm run build:ui";
  return "npm run lint";
}

function validateCommand(executable: string, args: string[], strict: boolean): string | null {
  if (!COMMAND_NAME.test(executable) || BLOCKED_SHELLS.has(executable)) return "Shell interpreters and executable paths are not allowed from chat.";
  if (args.some((arg) => arg === "-C" || arg === "--cwd" || arg === "--prefix" || path.isAbsolute(arg) || arg.split(/[\\/]/).includes(".."))) {
    return "Changing the command working directory is not allowed; commands run only in the registered project.";
  }
  if (args.some((arg) => /(?:^|[\\/])(?:\.env(?:\.|$)|\.ssh(?:[\\/]|$)|id_rsa|authorized_keys)(?:$|[\\/])/i.test(arg))) {
    return "Commands that target credentials or secret files are not allowed.";
  }
  if (["node", "deno", "bun", "python", "python3", "ruby", "perl"].includes(executable) && args.some((arg) => ["-e", "--eval", "-c", "eval"].includes(arg))) {
    return "Inline code evaluation is not allowed from chat; use a project script instead.";
  }
  if (!strict) return null;
  if (executable === "uv" && !(args[0] === "--version" || (args[0] === "python" && ["list", "find"].includes(args[1])))) {
    return "Managed Python environment changes require Approval or Full Access.";
  }
  if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
    const script = args[0] === "run" ? args[1] : args[0];
    if (args[0] === "install" || args[0] === "i" || args[0] === "add") return "Dependency installation requires Approval or Full Access.";
    if (!script || !SAFE_NPM_SCRIPTS.has(script) || (args[0] === "run" && args.length !== 2) || (args[0] !== "run" && args.length !== 1 && script !== "test")) {
      return "Only the project's test, typecheck, UI typecheck, UI build and lint scripts can run from chat.";
    }
  }
  if (executable === "npx" && !(args[0] === "tsc" && args[1] === "--noEmit") && !(args[0] === "vitest" && args[1] === "run")) {
    return "Only npx tsc --noEmit and npx vitest run are supported from chat.";
  }
  if (executable === "git" && (!args[0] || !SAFE_GIT_COMMANDS.has(args[0]) || /\b(reset|clean|checkout|switch|merge|rebase|push|pull|commit|add|restore|rm)\b/i.test(args.join(" ")))) {
    return "Only read-only git status, diff, log, branch and show commands are supported from chat.";
  }
  if (executable === "gh" && (!SAFE_GH_COMMANDS.has(args[0]) || /\b(create|edit|delete|merge|close|comment|checkout|pr\s+(merge|close))\b/i.test(args.join(" ")))) {
    return "Only read-only gh pull-request, run and issue queries are supported from chat.";
  }
  if (executable === "gh" && args.some((arg) => arg === "--repo" || arg.startsWith("--repo=") || arg === "--hostname" || arg.startsWith("--hostname="))) {
    return "gh queries must use the registered project's remote repository.";
  }
  if (executable === "gh" && args.includes("--web")) {
    return "Opening an external browser is not a chat command; use the project's link from the response.";
  }
  return null;
}

function tokenize(command: string): string[] | null {
  const tokens = command.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[^\s]+/g);
  return tokens?.map((token) => token.length >= 2 && ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) ? token.slice(1, -1) : token) ?? null;
}

function blockedPlan(requested: string, command: string, blockedReason: string): ChatCommandPlan {
  return { requested, executable: null, args: [], displayCommand: command, standardAllowed: false, blockedReason };
}

function blockedEvidence(plan: ChatCommandPlan, reason = plan.blockedReason ?? "The command was blocked before execution."): ChatCommandEvidence {
  return {
    requested: plan.requested,
    command: plan.displayCommand,
    status: "blocked",
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    detail: redactSensitiveText(reason)
  };
}

function pendingEvidence(plan: ChatCommandPlan, reason: string): ChatCommandEvidence {
  return {
    requested: plan.requested,
    command: plan.displayCommand,
    status: "pending",
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    detail: redactSensitiveText(reason)
  };
}

function safeOutput(value: string): string {
  return redactSensitiveText(truncateForDisplay(value.trim(), MAX_OUTPUT_LENGTH));
}
