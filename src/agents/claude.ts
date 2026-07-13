import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ProjectRecord, TaskRecord, TaskReviewStatus } from "../db.js";
import { AgentExecutionRequest, AgentExecutionResult, AgentHealth, AgentProvider } from "./types.js";
import { buildFailureSummary, classifyFailure, isRetryableFailureCategory } from "./failure.js";

export type ClaudeReviewResult = {
  status: TaskReviewStatus;
  content: string;
  error: string | null;
  durationMs: number;
  timedOut: boolean;
};

const DEFAULT_TIMEOUT_MS = 180_000;

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

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const health: AgentHealth = resolveClaudeCliCommand()
      ? { state: "ready", detail: "Claude CLI disponivel", checkedAt: new Date().toISOString() }
      : { state: "offline", detail: "Claude CLI nao encontrado", checkedAt: new Date().toISOString() };
    this.cacheHealth(health, 30_000);
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const result = await reviewTaskWithClaude(request.task, request.project, request.signal, this.timeoutMs);
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
      // reviewTaskWithClaude already replaces the raw error with a friendly Portuguese message
      // once authentication is confirmed, so that status is authoritative here; only the
      // remaining raw error text needs classification for quota/timeout/unknown.
      const category = result.status === "auth_required"
        ? "auth_required"
        : classifyFailure(result.error ?? "", result.timedOut);
      const healthState = category === "auth_required" ? "auth_required" : category === "quota" ? "quota" : "offline";
      this.cacheHealth({
        state: healthState,
        detail: result.error || "Claude indisponivel",
        checkedAt: new Date().toISOString()
      }, category === "auth_required" || category === "quota" ? 60_000 : 30_000);
      return {
        outcome: "failed",
        summary: buildFailureSummary("Claude", request.phase, category),
        output: "",
        error: result.error,
        durationMs: result.durationMs,
        retryable: isRetryableFailureCategory(category)
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
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ClaudeReviewResult> => {
  const startedAt = Date.now();
  const cwd = task.worktreePath || project.path;
  const cli = resolveClaudeCliCommand();

  if (!cli) {
    return {
      status: "failed",
      content: "",
      error: "Claude Code CLI was not found in the global npm installation.",
      durationMs: Date.now() - startedAt,
      timedOut: false
    };
  }

  if (!fs.existsSync(cwd)) {
    return {
      status: "failed",
      content: "",
      error: `Task workspace does not exist: ${cwd}`,
      durationMs: Date.now() - startedAt,
      timedOut: false
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

  const result = await runProcess(cli.command, args, cwd, timeoutMs, signal);
  const errorText = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();

  if (result.exitCode === 0 && result.stdout.trim()) {
    return {
      status: "completed",
      content: result.stdout.trim(),
      error: null,
      durationMs: Date.now() - startedAt,
      timedOut: false
    };
  }

  const authenticationFailed = !result.timedOut && isClaudeAuthenticationError(errorText);
  return {
    status: authenticationFailed ? "auth_required" : "failed",
    content: "",
    error: authenticationFailed
      ? "Claude Code precisa ser reautenticado antes da revisao."
      : errorText || "Claude review failed without output.",
    durationMs: Date.now() - startedAt,
    timedOut: result.timedOut
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
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; aborted: boolean; timedOut: boolean }>((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), aborted, timedOut });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, aborted, timedOut });
    });
    if (signal?.aborted) onAbort();
  });
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 2_000_000 ? next : next.slice(-2_000_000);
}
