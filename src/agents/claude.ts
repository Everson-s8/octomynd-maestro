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

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly capabilities = new Set(["reviewing"] as const);

  async health(): Promise<AgentHealth> {
    return resolveClaudeCliEntry()
      ? { state: "ready", detail: "Claude CLI disponivel", checkedAt: new Date().toISOString() }
      : { state: "offline", detail: "Claude CLI nao encontrado", checkedAt: new Date().toISOString() };
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const result = await reviewTaskWithClaude(request.task, request.project);
    if (result.status !== "completed") {
      return {
        outcome: "failed",
        summary: result.error || "Claude review failed.",
        output: "",
        error: result.error,
        durationMs: result.durationMs,
        retryable: result.status === "auth_required"
      };
    }

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
}

export const reviewTaskWithClaude: ClaudeReviewer = async (task, project) => {
  const startedAt = Date.now();
  const cwd = task.worktreePath || project.path;
  const cliEntry = resolveClaudeCliEntry();

  if (!cliEntry) {
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
    cliEntry,
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

  const result = await runProcess(process.execPath, args, cwd, 180_000);
  const errorText = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();

  if (result.exitCode === 0 && result.stdout.trim()) {
    return {
      status: "completed",
      content: result.stdout.trim(),
      error: null,
      durationMs: Date.now() - startedAt
    };
  }

  const authenticationFailed = /401|authentication|credentials/i.test(errorText);
  return {
    status: authenticationFailed ? "auth_required" : "failed",
    content: "",
    error: authenticationFailed
      ? "Claude Code precisa ser reautenticado antes da revisão."
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

function resolveClaudeCliEntry(): string | null {
  const candidates = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
      : "",
    process.env.NPM_CONFIG_PREFIX
      ? path.join(process.env.NPM_CONFIG_PREFIX, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
      : ""
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 2_000_000 ? next : next.slice(-2_000_000);
}
