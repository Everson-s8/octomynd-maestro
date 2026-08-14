import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AgentProcessResult, buildRestrictedAgentEnvironment, runAgentProcess } from "./process.js";
import {
  buildFailureSummary,
  classifyFailure,
  isRetryableFailureCategory,
  retryAfterMsForFailure,
  type FailureCategory
} from "./failure.js";
import { buildAgentGoalPrompt } from "./goal-prompt.js";
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentHealth,
  AgentProvider
} from "./types.js";
import type {
  ImprovementReviewExecutionRequest,
  ImprovementReviewExecutionResult
} from "../improvements/reviewer.js";
import { redactSensitiveText } from "../security/redaction.js";
import { withRemediation } from "./remediation.js";
import { filesystemAccessForExecution } from "./execution-policy.js";
import {
  DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS,
  normalizeProviderExecutionLimits,
  ProviderExecutionLimits
} from "./execution-limits.js";

const CODEX_CAPABILITIES = new Set([
  "planning",
  "coding",
  "testing",
  "reviewing",
  "improvement_reviewing",
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

  private readonly executionLimits: ProviderExecutionLimits;

  constructor(executionLimits?: number | Partial<ProviderExecutionLimits>) {
    this.executionLimits = normalizeProviderExecutionLimits(
      executionLimits,
      DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS
    );
  }

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const cliEntry = resolveCodexCliEntry();
    const envKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
    const health: AgentHealth = cliEntry
      ? { state: "ready", detail: "Codex CLI disponivel", checkedAt: new Date().toISOString() }
      : envKey
        ? { state: "ready", detail: "Codex API Key disponivel via ENV", checkedAt: new Date().toISOString() }
        : {
          state: "offline",
          detail: withRemediation("codex", "offline", "Codex CLI ou API Key nao encontrado."),
          checkedAt: new Date().toISOString()
        };
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

    const sandbox = codexSandboxForRequest(request);
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
      provider: this.id,
      stdin: buildCodexGoalPrompt(request),
      timeoutMs: this.executionLimits.maxRuntimeMs,
      inactivityTimeoutMs: this.executionLimits.inactivityTimeoutMs,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
      env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
    });
    if (processResult.aborted) {
      return {
        outcome: "cancelled",
        summary: "Codex execution cancelled by user.",
        structuredPayload: null,
        artifactsProduced: [],
        output: "",
        error: null,
        durationMs: Date.now() - startedAt,
        retryable: false,
        processRuntime: processRuntime(processResult),
        tokenUsage: processResult.tokenUsage,
        model: "codex"
      };
    }
    const combined = [
      processResult.stderr,
      processResult.stdout,
      processResult.breakerReason ? `process breaker: ${processResult.breakerReason}` : ""
    ].filter(Boolean).join("\n").trim();
    if (processResult.exitCode !== 0) {
      const category = classifyFailure(combined, {
        provider: this.id,
        phase: request.phase,
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
        aborted: processResult.aborted,
        breakerReason: processResult.breakerReason,
        spawnErrorCode: processResult.spawnErrorCode
      });
      const retryable = isRetryableFailureCategory(category);
      const summary = buildFailureSummary(this.label, request.phase, category);
      if (category === "quota") this.cacheHealth("quota", withRemediation("codex", "quota", summary), 10 * 60_000);
      if (category === "auth_required") {
        this.cacheHealth("auth_required", withRemediation("codex", "auth_required", summary), 10 * 60_000);
      }
      return {
        outcome: "failed",
        summary,
        structuredPayload: null,
        failureCategory: category,
        retryable,
        retryAfterMs: retryAfterMsForFailure(category),
        artifactsProduced: [],
        output: combined,
        error: combined || summary,
        durationMs: processResult.durationMs,
        processRuntime: processRuntime(processResult),
        tokenUsage: processResult.tokenUsage,
        model: "codex"
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
        structuredPayload: parsed as unknown as Record<string, unknown>,
        artifactsProduced: [outputPath],
        output: parsed.details.trim(),
        error: parsed.outcome === "failed" ? parsed.details.trim() : null,
        durationMs: Date.now() - startedAt,
        retryable: false,
        processRuntime: processRuntime(processResult),
        tokenUsage: processResult.tokenUsage,
        model: "codex"
      };
    } catch (error) {
      const detail = `Codex retornou saida invalida: ${error instanceof Error ? error.message : "erro desconhecido"}`;
      const category = classifyFailure(detail, {
        provider: this.id,
        phase: request.phase,
        jsonError: { code: "invalid_output", message: detail }
      });
      return failure(
        buildFailureSummary(this.label, request.phase, category),
        startedAt,
        isRetryableFailureCategory(category),
        combined || detail,
        detail,
        processRuntime(processResult),
        "unknown"
      );
    }
  }

  async reviewImprovements(
    request: ImprovementReviewExecutionRequest
  ): Promise<ImprovementReviewExecutionResult> {
    const startedAt = Date.now();
    const cliEntry = resolveCodexCliEntry();
    if (!cliEntry) return improvementFailure("Codex CLI nao encontrado.", startedAt, false);
    if (!fs.existsSync(request.workspacePath)) {
      return improvementFailure(`Workspace nao existe: ${request.workspacePath}`, startedAt, false);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-improvement-codex-"));
    const schemaPath = path.join(tempDir, "result.schema.json");
    const outputPath = path.join(tempDir, "result.json");
    try {
      fs.writeFileSync(schemaPath, JSON.stringify(request.schema), "utf8");
      const processResult = await runAgentProcess({
        command: process.execPath,
        args: buildCodexImprovementReviewArgs(cliEntry, request, schemaPath, outputPath),
        cwd: request.workspacePath,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        maxOutputChars: request.maxOutputChars,
        maxReceivedChars: request.maxOutputChars * 2,
        env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
      });
      if (processResult.aborted || request.signal?.aborted) {
        return {
          status: "cancelled",
          output: "",
          error: null,
          durationMs: processResult.durationMs,
          retryable: false
        };
      }
      const diagnostics = [processResult.stderr, processResult.stdout].filter(Boolean).join("\n").trim();
      if (processResult.exitCode !== 0) {
        const category = classifyFailure(diagnostics, {
          provider: this.id,
          phase: "reviewing",
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
          aborted: processResult.aborted,
          breakerReason: processResult.breakerReason,
          spawnErrorCode: processResult.spawnErrorCode
        });
        return improvementFailure(
          diagnostics || buildFailureSummary(this.label, "reviewing", category),
          startedAt,
          isRetryableFailureCategory(category),
          retryAfterMsForFailure(category)
        );
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size > request.maxOutputChars) {
        return improvementFailure("Codex improvement output is missing or exceeds the configured limit.", startedAt, false);
      }
      return {
        status: "completed",
        output: fs.readFileSync(outputPath, "utf8"),
        error: null,
        durationMs: Date.now() - startedAt,
        retryable: false
      };
    } catch (error) {
      return improvementFailure(error instanceof Error ? error.message : "Codex improvement review failed.", startedAt, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
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
  return buildAgentGoalPrompt(request, {
    output: "Return the requested JSON schema. The details field must record files, tests, blockers and relevant evidence.",
    reviewingVerdict: "Report your verdict in the outcome field: 'completed' to approve or 'changes_requested' to request changes."
  });
}

export function codexSandboxForCapability(capability: AgentExecutionRequest["capability"]): "read-only" | "workspace-write" {
  return capability === "coding" || capability === "testing" ? "workspace-write" : "read-only";
}

export function codexSandboxForRequest(request: AgentExecutionRequest): "read-only" | "workspace-write" {
  return filesystemAccessForExecution(request) === "workspace_write" ? "workspace-write" : "read-only";
}

export function buildCodexImprovementReviewArgs(
  cliEntry: string,
  request: ImprovementReviewExecutionRequest,
  schemaPath: string,
  outputPath: string
): string[] {
  return [
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
    "read-only",
    "--cd",
    request.workspacePath,
    "-"
  ];
}

export function isCodexQuotaError(errorText: string): boolean {
  return /usage limit|rate limit|quota|credits/i.test(errorText);
}

export function isCodexAuthenticationError(errorText: string): boolean {
  return /401|authentication|login required|credentials/i.test(errorText);
}

export function resolveCodexCliEntry(): string | null {
  const candidates = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : "",
    process.env.NPM_CONFIG_PREFIX
      ? path.join(process.env.NPM_CONFIG_PREFIX, "node_modules", "@openai", "codex", "bin", "codex.js")
      : ""
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  try {
    const cmd = process.platform === "win32" ? "codex.cmd" : "codex";
    const res = spawnSync(cmd, ["--version"], { windowsHide: true, timeout: 3_000 });
    if (res.status === 0) return cmd;
  } catch {}
  return null;
}

function failure(
  summary: string,
  startedAt: number,
  retryable: boolean,
  output = "",
  error = summary,
  runtime?: NonNullable<AgentExecutionResult["processRuntime"]>,
  failureCategory: FailureCategory = "unknown"
): AgentExecutionResult {
  return {
    outcome: "failed",
    summary,
    structuredPayload: null,
    failureCategory,
    retryable,
    artifactsProduced: [],
    output,
    error,
    durationMs: Date.now() - startedAt,
    processRuntime: runtime
  };
}

function improvementFailure(
  error: string,
  startedAt: number,
  retryable: boolean,
  retryAfterMs?: number
): ImprovementReviewExecutionResult {
  return {
    status: "failed",
    output: "",
    error: redactSensitiveText(error).slice(0, 2_000),
    durationMs: Date.now() - startedAt,
    retryable,
    retryAfterMs
  };
}
