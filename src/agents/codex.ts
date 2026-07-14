import fs from "node:fs";
import path from "node:path";
import { AgentProcessResult, buildRestrictedAgentEnvironment, runAgentProcess } from "./process.js";
import { buildFailureSummary, classifyFailure, isRetryableFailureCategory } from "./failure.js";
import { formatLegacyPreviousSteps, formatTokenEfficientPreviousSteps } from "../runtime/compression.js";
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentHealth,
  AgentProvider
} from "./types.js";

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

  constructor(private readonly executionTimeoutMs = 6 * 60_000) {}

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

    const sandbox = codexSandboxForCapability(request.capability);
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

    const processResult = await runAgentProcess({
      command: process.execPath,
      args,
      cwd,
      stdin: buildPrompt(request),
      timeoutMs: this.executionTimeoutMs,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
      env: buildRestrictedAgentEnvironment()
    });
    if (processResult.aborted) {
      return {
        outcome: "cancelled",
        summary: "Codex execution cancelled by user.",
        output: "",
        error: null,
        durationMs: Date.now() - startedAt,
        retryable: false,
        processRuntime: processRuntime(processResult)
      };
    }
    const combined = [
      processResult.stderr,
      processResult.stdout,
      processResult.breakerReason ? `process breaker: ${processResult.breakerReason}` : ""
    ].filter(Boolean).join("\n").trim();
    if (processResult.exitCode !== 0) {
      const category = classifyFailure(combined, processResult.timedOut);
      const retryable = isRetryableFailureCategory(category);
      const summary = buildFailureSummary(this.label, request.phase, category);
      if (category === "quota") this.cacheHealth("quota", summary, 10 * 60_000);
      if (category === "auth_required") this.cacheHealth("auth_required", summary, 10 * 60_000);
      return {
        outcome: "failed",
        summary,
        output: combined,
        error: combined || summary,
        durationMs: processResult.durationMs,
        retryable,
        processRuntime: processRuntime(processResult)
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
        retryable: false,
        processRuntime: processRuntime(processResult)
      };
    } catch (error) {
      const detail = `Codex retornou saida invalida: ${error instanceof Error ? error.message : "erro desconhecido"}`;
      return failure(
        buildFailureSummary(this.label, request.phase, "unknown"),
        startedAt,
        false,
        combined || detail,
        detail,
        processRuntime(processResult)
      );
    }
  }

  private cacheHealth(state: AgentHealth["state"], detail: string, ttlMs: number) {
    this.cachedHealth = { state, detail, checkedAt: new Date().toISOString() };
    this.healthExpiresAt = Date.now() + ttlMs;
  }
}

function processRuntime(result: AgentProcessResult): NonNullable<AgentExecutionResult["processRuntime"]> {
  return { breakerReason: result.breakerReason, outputStats: result.outputStats };
}

export function buildCodexGoalPrompt(request: AgentExecutionRequest): string {
  return buildPrompt(request);
}

export function codexSandboxForCapability(capability: AgentExecutionRequest["capability"]): "read-only" | "workspace-write" {
  return capability === "coding" || capability === "testing" ? "workspace-write" : "read-only";
}

export function isCodexQuotaError(errorText: string): boolean {
  return /usage limit|rate limit|quota|credits/i.test(errorText);
}

export function isCodexAuthenticationError(errorText: string): boolean {
  return /401|authentication|login required|credentials/i.test(errorText);
}

function buildPrompt(request: AgentExecutionRequest): string {
  const previous = request.previousStepHandoff
    ? formatTokenEfficientPreviousSteps(request.previousStepHandoff)
    : formatLegacyPreviousSteps(request.previousSteps);
  const phaseInstruction = {
    planning: "Inspecione o repositorio e produza um plano executavel. Nao edite arquivos.",
    implementing: "Implemente integralmente a task no workspace. Preserve o escopo e nao faca commit nem push.",
    testing: "Rode os testes mais relevantes. Corrija apenas falhas causadas pela task e valide novamente.",
    reviewing: "Revise o diff, requisitos e testes. Nao edite. Use changes_requested somente para problemas concretos."
  }[request.phase];

  return [
    "Voce e um worker do Octomynd Maestro executando uma goal persistente.",
    "Trabalhe autonomamente nesta etapa, sem pedir atualizacao manual da task.",
    "Use respostas estruturadas e tersas nos handoffs internos.",
    "Nao use estilo Caveman em decisoes de seguranca, review final, merge ou mensagens importantes ao usuario.",
    "Nunca faca commit, push, merge, deploy, altere credenciais ou saia do workspace.",
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

function failure(
  summary: string,
  startedAt: number,
  retryable: boolean,
  output = "",
  error = summary,
  runtime?: NonNullable<AgentExecutionResult["processRuntime"]>
): AgentExecutionResult {
  return {
    outcome: "failed",
    summary,
    output,
    error,
    durationMs: Date.now() - startedAt,
    retryable,
    processRuntime: runtime
  };
}
