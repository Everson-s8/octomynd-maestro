import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ProjectRecord, TaskRecord, TaskReviewStatus } from "../db.js";
import { AgentExecutionRequest, AgentExecutionResult, AgentHealth, AgentProvider } from "./types.js";

export type ClaudeReviewResult = {
  status: TaskReviewStatus;
  content: string;
  error: string | null;
  durationMs: number;
};

export type ClaudeReviewer = (task: TaskRecord, project: ProjectRecord) => Promise<ClaudeReviewResult>;

type ClaudeCliCommand = {
  command: string;
  argsPrefix: string[];
};

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly capabilities = new Set(["reviewing"] as const);
  private cachedHealth: AgentHealth | null = null;
  private healthExpiresAt = 0;

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const health: AgentHealth = resolveClaudeCliCommand()
      ? { state: "ready", detail: "Claude CLI disponivel", checkedAt: new Date().toISOString() }
      : { state: "offline", detail: "Claude CLI nao encontrado", checkedAt: new Date().toISOString() };
    this.cacheHealth(health, 30_000);
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const result = await reviewTaskWithClaude(request.task, request.project, request.signal);
    if (request.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: "Claude execution cancelled by user.",
        output: "",
        error: null,
        durationMs: result.durationMs,
        retryable: false
      };
    }
    if (result.status !== "completed") {
      this.cacheHealth({
        state: result.status === "auth_required" ? "auth_required" : "offline",
        detail: result.error || "Claude indisponivel",
        checkedAt: new Date().toISOString()
      }, result.status === "auth_required" ? 60_000 : 30_000);
      return {
        outcome: "failed",
        summary: result.error || "Claude review failed.",
        output: "",
        error: result.error,
        durationMs: result.durationMs,
        retryable: result.status === "auth_required"
      };
    }

    this.cacheHealth({
      state: "ready",
      detail: "Claude CLI autenticado",
      checkedAt: new Date().toISOString()
    }, 30_000);
    const requestsChanges = /reprovado|aprovado com ajustes|mudancas? solicitadas?/i.test(result.content);
    return {
      outcome: requestsChanges ? "changes_requested" : "completed",
      summary: requestsChanges ? "Claude solicitou ajustes concretos." : "Claude aprovou a etapa.",
      output: result.content,
      error: null,
      durationMs: result.durationMs,
      retryable: false
    };
  }

  private cacheHealth(health: AgentHealth, ttlMs: number) {
    this.cachedHealth = health;
    this.healthExpiresAt = Date.now() + ttlMs;
  }
}

export const reviewTaskWithClaude = async (
  task: TaskRecord,
  project: ProjectRecord,
  signal?: AbortSignal
): Promise<ClaudeReviewResult> => {
  const startedAt = Date.now();
  const cwd = task.worktreePath || project.path;
  const cli = resolveClaudeCliCommand();

  if (!cli) {
    return {
      status: "failed",
      content: "",
      error: "Claude Code CLI was not found in the global npm installation.",
      durationMs: Date.now() - startedAt
    };
  }

  if (!fs.existsSync(cwd)) {
    return {
      status: "failed",
      content: "",
      error: `Task workspace does not exist: ${cwd}`,
      durationMs: Date.now() - startedAt
    };
  }

  const args = [
    ...cli.argsPrefix,
    "--print",
    buildClaudeReviewPrompt(task, project),
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--add-dir",
    cwd,
    "--no-session-persistence"
  ];

  const result = await runProcess(cli.command, args, cwd, 180_000, signal);
  const errorText = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();

  if (result.exitCode === 0 && result.stdout.trim()) {
    return {
      status: "completed",
      content: result.stdout.trim(),
      error: null,
      durationMs: Date.now() - startedAt
    };
  }

  const authenticationFailed = isClaudeAuthenticationError(errorText);
  return {
    status: authenticationFailed ? "auth_required" : "failed",
    content: "",
    error: authenticationFailed
      ? "Claude Code precisa ser reautenticado antes da revisao."
      : errorText || "Claude review failed without output.",
    durationMs: Date.now() - startedAt
  };
};

export function buildClaudeReviewPrompt(task: TaskRecord, project: ProjectRecord): string {
  return [
    "Voce e o revisor de produto e design do Octomynd Maestro.",
    "Trabalhe somente em modo leitura. Nao edite arquivos e nao execute comandos.",
    `Projeto: ${project.name} (@${project.key})`,
    `Task #${task.id}: ${task.text}`,
    "",
    "Analise o estado atual do repositorio e entregue em portugues:",
    "1. pontos fortes;",
    "2. problemas de UX, acessibilidade e coerencia visual;",
    "3. cinco melhorias priorizadas com arquivos/componentes afetados;",
    "4. riscos de implementar as mudancas;",
    "5. veredito curto: aprovado, aprovado com ajustes ou reprovado.",
    "Se existir docs/VISUAL_IDENTITY.md, use-o como contrato visual."
  ].join("\n");
}

export function buildClaudeCliCommand(cliEntry: string): ClaudeCliCommand {
  return cliEntry.toLowerCase().endsWith(".js")
    ? { command: process.execPath, argsPrefix: [cliEntry] }
    : { command: cliEntry, argsPrefix: [] };
}

export function isClaudeAuthenticationError(errorText: string): boolean {
  return /401|authentication|credentials|not logged in|please run \/login|sign in/i.test(errorText);
}

function resolveClaudeCliCommand(): ClaudeCliCommand | null {
  const roots = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code")
      : "",
    process.env.NPM_CONFIG_PREFIX
      ? path.join(process.env.NPM_CONFIG_PREFIX, "node_modules", "@anthropic-ai", "claude-code")
      : ""
  ].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    path.join(root, "bin", "claude.exe"),
    path.join(root, "cli.js")
  ]);
  const cliEntry = candidates.find((candidate) => fs.existsSync(candidate));
  return cliEntry ? buildClaudeCliCommand(cliEntry) : null;
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; aborted: boolean }>((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), aborted });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, aborted });
    });
    if (signal?.aborted) onAbort();
  });
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 2_000_000 ? next : next.slice(-2_000_000);
}
