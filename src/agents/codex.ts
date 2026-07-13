import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentHealth,
  AgentProvider
} from "./types.js";
import { buildFailureSummary, classifyFailure, isRetryableFailureCategory } from "./failure.js";

const DEFAULT_TIMEOUT_MS = 20 * 60_000;

const CODEX_CAPABILITIES = new Set([
  "planning",
  "coding",
  "testing",
  "reviewing",
  "research"
] as const);

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "details"],
  properties: {
    outcome: { type: "string", enum: ["completed", "changes_requested", "blocked", "failed"] },
    summary: { type: "string" },
    details: { type: "string" }
  }
};

export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly capabilities = CODEX_CAPABILITIES;
  private cachedHealth: AgentHealth | null = null;
  private healthExpiresAt = 0;

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const cliEntry = resolveCodexCliEntry();
    const health: AgentHealth = cliEntry
      ? { state: "ready", detail: "Codex CLI disponivel", checkedAt: new Date().toISOString() }
      : { state: "offline", detail: "Codex CLI nao encontrado", checkedAt: new Date().toISOString() };
    this.cachedHealth = health;
    this.healthExpiresAt = Date.now() + 30_000;
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const startedAt = Date.now();
    const cliEntry = resolveCodexCliEntry();
    if (!cliEntry) {
      return failure("Codex CLI nao encontrado.", startedAt, false);
    }

    const cwd = request.task.worktreePath || request.project.path;
    if (!fs.existsSync(cwd)) {
      return failure(`Workspace nao existe: ${cwd}`, startedAt, false);
    }

    const artifactDir = path.join(
      request.artifactsRoot,
      `goal-${request.runId}`,
      `step-${String(request.stepNumber).padStart(2, "0")}-${request.phase}`
    );
    fs.mkdirSync(artifactDir, { recursive: true });
    const schemaPath = path.join(artifactDir, "result.schema.json");
    const outputPath = path.join(artifactDir, "result.json");
    fs.writeFileSync(schemaPath, JSON.stringify(RESULT_SCHEMA, null, 2), "utf8");

    const sandbox = request.capability === "coding" || request.capability === "testing"
      ? "workspace-write"
      : "read-only";
    const args = [
      cliEntry,
      "exec",
      "--ephemeral",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--sandbox",
      sandbox,
      "--cd",
      cwd,
      "-"
    ];

    const processResult = await runProcess(process.execPath, args, cwd, buildPrompt(request), this.timeoutMs, request.signal);
    if (processResult.aborted) {
      return {
        outcome: "cancelled",
        summary: "Codex execution cancelled by user.",
        output: "",
        error: null,
        durationMs: Date.now() - startedAt,
        retryable: false
      };
    }
    const combined = [processResult.stderr, processResult.stdout].filter(Boolean).join("\n").trim();
    if (processResult.exitCode !== 0) {
      const category = classifyFailure(combined, processResult.timedOut);
      if (category === "quota") this.cacheHealth("quota", "Codex aguardando renovacao de cota.", 10 * 60_000);
      if (category === "auth_required") this.cacheHealth("auth_required", "Codex requer autenticacao.", 10 * 60_000);
      return {
        outcome: "failed",
        summary: buildFailureSummary("Codex", request.phase, category),
        output: combined,
        error: combined || "Codex terminou sem resposta.",
        durationMs: Date.now() - startedAt,
        retryable: isRetryableFailureCategory(category)
      };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
        outcome: AgentExecutionResult["outcome"];
        summary: string;
        details: string;
      };
      this.cacheHealth("ready", "Codex CLI disponivel", 30_000);
      return {
        outcome: parsed.outcome,
        summary: parsed.summary.trim(),
        output: parsed.details.trim(),
        error: parsed.outcome === "failed" ? parsed.details.trim() : null,
        durationMs: Date.now() - startedAt,
        retryable: false
      };
    } catch (error) {
      return failure(
        `Codex retornou saida invalida: ${error instanceof Error ? error.message : "erro desconhecido"}`,
        startedAt,
        false,
        combined
      );
    }
  }

  private cacheHealth(state: AgentHealth["state"], detail: string, ttlMs: number) {
    this.cachedHealth = { state, detail, checkedAt: new Date().toISOString() };
    this.healthExpiresAt = Date.now() + ttlMs;
  }
}

export function buildCodexGoalPrompt(request: AgentExecutionRequest): string {
  return buildPrompt(request);
}

function buildPrompt(request: AgentExecutionRequest): string {
  const previous = request.previousSteps.length === 0
    ? "Nenhuma etapa anterior."
    : request.previousSteps.map((step) => (
      `- ${step.phase}/${step.provider}/${step.status}: ${step.summary}\n` +
      `  detalhes: ${step.output.slice(0, 2_000) || "sem detalhes"}`
    )).join("\n");
  const phaseInstruction = {
    planning: "Inspecione o repositorio e produza um plano executavel. Nao edite arquivos.",
    implementing: "Implemente integralmente a task no workspace. Preserve o escopo e nao faca commit nem push.",
    testing: "Rode os testes mais relevantes. Corrija apenas falhas causadas pela task e valide novamente.",
    reviewing: "Revise o diff, requisitos e testes. Nao edite. Use changes_requested somente para problemas concretos."
  }[request.phase];

  return [
    "Voce e um worker do Octomynd Maestro executando uma goal persistente.",
    "Trabalhe autonomamente nesta etapa, sem pedir atualizacao manual da task.",
    "Nao faça commit, push, merge, deploy, altere credenciais ou saia do workspace.",
    `Projeto: ${request.project.name} (@${request.project.key})`,
    `Task #${request.task.id}: ${request.task.text}`,
    `Fase: ${request.phase}`,
    phaseInstruction,
    "",
    "Historico resumido das etapas:",
    previous,
    ...(request.humanFeedback ? ["", "Ajustes solicitados pela pessoa responsavel:", request.humanFeedback] : []),
    "",
    "Retorne o schema solicitado. details deve registrar arquivos, testes, bloqueios e evidencias relevantes."
  ].join("\n");
}

function resolveCodexCliEntry(): string | null {
  const candidates = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : "",
    process.env.NPM_CONFIG_PREFIX
      ? path.join(process.env.NPM_CONFIG_PREFIX, "node_modules", "@openai", "codex", "bin", "codex.js")
      : ""
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal
) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; aborted: boolean; timedOut: boolean }>((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(stdin);
    if (signal?.aborted) onAbort();
  });
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 2_000_000 ? next : next.slice(-2_000_000);
}

function failure(error: string, startedAt: number, retryable: boolean, output = ""): AgentExecutionResult {
  return {
    outcome: "failed",
    summary: error,
    output,
    error,
    durationMs: Date.now() - startedAt,
    retryable
  };
}
