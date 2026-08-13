import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAgentGoalPrompt, parseFinalReviewDecision } from "./goal-prompt.js";
import {
  buildFailureSummary,
  classifyFailure,
  isRetryableFailureCategory,
  retryAfterMsForFailure,
  type FailureCategory
} from "./failure.js";
import { isWritableExecution } from "./execution-policy.js";
import {
  DEFAULT_ANTIGRAVITY_INACTIVITY_TIMEOUT_MS,
  normalizeProviderExecutionLimits,
  type ProviderExecutionLimits
} from "./execution-limits.js";
import {
  buildRestrictedAgentEnvironment,
  runAgentProcess,
  type AgentProcessResult
} from "./process.js";
import type {
  AgentCapability,
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

const ANTIGRAVITY_CAPABILITIES = new Set<AgentCapability>([
  "planning",
  "coding",
  "testing",
  "reviewing",
  "improvement_reviewing",
  "research",
  "conversation"
]);

export type AntigravityProviderOptions = {
  model?: string | null;
  effort?: "low" | "medium" | "high";
  executionLimits?: number | Partial<ProviderExecutionLimits>;
  executablePath?: string;
  healthProbe?: boolean;
};

export class AntigravityProvider implements AgentProvider {
  readonly id = "antigravity" as const;
  readonly label = "Gemini Antigravity";
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  private readonly executionLimits: ProviderExecutionLimits;
  private readonly model: string | null;
  private readonly effort: "low" | "medium" | "high";
  private readonly executablePath?: string;
  private readonly healthProbe: boolean;
  private cachedHealth: AgentHealth | null = null;
  private healthExpiresAt = 0;

  constructor(options: AntigravityProviderOptions = {}) {
    this.executionLimits = normalizeProviderExecutionLimits(
      options.executionLimits,
      DEFAULT_ANTIGRAVITY_INACTIVITY_TIMEOUT_MS
    );
    this.model = options.model?.trim() || null;
    this.effort = options.effort ?? "medium";
    this.executablePath = options.executablePath;
    this.healthProbe = options.healthProbe ?? true;
  }

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const executable = resolveAntigravityExecutable(this.executablePath);
    const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    let health: AgentHealth;
    if (!executable) {
      health = envKey
        ? { state: "ready", detail: "Gemini API Key disponivel via ENV", checkedAt: new Date().toISOString() }
        : { state: "offline", detail: "Antigravity CLI nao encontrado", checkedAt: new Date().toISOString() };
    } else if (!this.healthProbe) {
      health = { state: "ready", detail: "Antigravity CLI disponivel", checkedAt: new Date().toISOString() };
    } else {
      const probe = await runAgentProcess({
        command: executable,
        args: ["models"],
        cwd: process.cwd(),
        timeoutMs: 15_000,
        inactivityTimeoutMs: 15_000,
        maxOutputChars: 20_000,
        env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
      });
      const diagnostics = [probe.stderr, probe.stdout].filter(Boolean).join("\n").trim();
      const category = probe.exitCode === 0 ? null : classifyFailure(diagnostics, {
        provider: this.id,
        phase: "probe",
        exitCode: probe.exitCode,
        timedOut: probe.timedOut,
        aborted: probe.aborted,
        breakerReason: probe.breakerReason,
        spawnErrorCode: probe.spawnErrorCode
      });
      health = category === "auth_required"
        ? { state: "auth_required", detail: "Antigravity precisa de login.", checkedAt: new Date().toISOString() }
        : probe.exitCode === 0
          ? { state: "ready", detail: "Antigravity CLI autenticado", checkedAt: new Date().toISOString() }
          : { state: "offline", detail: "Antigravity CLI indisponivel.", checkedAt: new Date().toISOString() };
    }
    this.cacheHealth(health, 30_000);
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const executable = resolveAntigravityExecutable(this.executablePath);
    const cwd = request.task.worktreePath || request.project.path;
    if (!executable || !fs.existsSync(cwd)) {
      const detail = !executable
        ? "Antigravity CLI nao encontrado."
        : `Workspace nao existe: ${cwd}`;
      return failure(detail);
    }

    const processResult = await runAgentProcess({
      command: executable,
      args: buildAntigravityArgs(
        request,
        this.model,
        this.effort,
        this.executionLimits.maxRuntimeMs ?? 8 * 60 * 60_000
      ),
      cwd,
      provider: this.id,
      timeoutMs: this.executionLimits.maxRuntimeMs,
      inactivityTimeoutMs: this.executionLimits.inactivityTimeoutMs,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
      env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
    });
    if (processResult.aborted || request.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: "Antigravity execution cancelled by user.",
        structuredPayload: null,
        artifactsProduced: [],
        output: "",
        error: null,
        durationMs: processResult.durationMs,
        retryable: false,
        processRuntime: processRuntime(processResult),
        tokenUsage: processResult.tokenUsage,
        model: this.model ?? "antigravity"
      };
    }

    const diagnostics = [processResult.stderr, processResult.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (processResult.exitCode !== 0 || !processResult.stdout.trim()) {
      const category = classifyFailure(diagnostics, {
        provider: this.id,
        phase: request.phase,
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
        aborted: processResult.aborted,
        breakerReason: processResult.breakerReason,
        spawnErrorCode: processResult.spawnErrorCode
      });
      const summary = buildFailureSummary(this.label, request.phase, category);
      if (category === "quota" || category === "auth_required") {
        this.cacheHealth({ state: category, detail: summary, checkedAt: new Date().toISOString() }, 10 * 60_000);
      } else if (category === "offline" || category === "capacity") {
        this.cacheHealth({ state: "offline", detail: summary, checkedAt: new Date().toISOString() }, 30_000);
      } else if (category === "timeout" && processResult.breakerReason === "inactivity") {
        // A hang on inactivity is a provider-health signal -> mark offline (retryable).
        // Other timeouts (phase_timeout/deadline: the task simply ran long) must NOT
        // mark the provider offline, matching claude.ts's treatment.
        this.cacheHealth({ state: "offline", detail: summary, checkedAt: new Date().toISOString() }, 30_000);
      }
      return {
        outcome: "failed",
        summary,
        structuredPayload: null,
        failureCategory: category,
        retryable: isRetryableFailureCategory(category),
        retryAfterMs: retryAfterMsForFailure(category),
        artifactsProduced: [],
        output: diagnostics,
        error: diagnostics || summary,
        durationMs: processResult.durationMs,
        processRuntime: processRuntime(processResult),
        tokenUsage: processResult.tokenUsage,
        model: this.model ?? "antigravity"
      };
    }

    this.cacheHealth({
      state: "ready",
      detail: "Antigravity CLI autenticado",
      checkedAt: new Date().toISOString()
    }, 30_000);
    const output = processResult.stdout.trim();
    const reviewDecision = request.phase === "reviewing"
      ? parseFinalReviewDecision(output)
      : null;
    const changesRequested = request.phase === "reviewing" && reviewDecision !== "approved";
    return {
      outcome: changesRequested ? "changes_requested" : "completed",
      summary: changesRequested
        ? reviewDecision === "changes_requested"
          ? "Antigravity solicitou ajustes concretos."
          : "Antigravity nao aprovou explicitamente a revisao final."
        : `Antigravity concluiu a fase ${request.phase}.`,
      structuredPayload: request.phase === "reviewing" ? { reviewDecision } : { phase: request.phase },
      artifactsProduced: [],
      output,
      error: null,
      durationMs: processResult.durationMs,
      retryable: false,
      processRuntime: processRuntime(processResult),
      tokenUsage: processResult.tokenUsage,
      model: this.model ?? "antigravity"
    };
  }

  async reviewImprovements(
    request: ImprovementReviewExecutionRequest
  ): Promise<ImprovementReviewExecutionResult> {
    const executable = resolveAntigravityExecutable(this.executablePath);
    if (!executable || !fs.existsSync(request.workspacePath)) {
      const error = !executable
        ? "Antigravity CLI nao encontrado."
        : `Workspace nao existe: ${request.workspacePath}`;
      return improvementFailure(error, false);
    }
    const processResult = await runAgentProcess({
      command: executable,
      args: [
        "--print",
        request.prompt,
        "--output-format",
        "text",
        "--mode",
        "plan",
        "--effort",
        this.effort,
        "--sandbox",
        "--disable-slash-commands",
        "--add-dir",
        request.workspacePath,
        "--print-timeout",
        `${Math.ceil(request.timeoutMs / 1_000)}s`,
        ...(this.model ? ["--model", this.model] : [])
      ],
      cwd: request.workspacePath,
      timeoutMs: request.timeoutMs,
      inactivityTimeoutMs: this.executionLimits.inactivityTimeoutMs,
      signal: request.signal,
      maxOutputChars: request.maxOutputChars,
      maxReceivedChars: request.maxOutputChars * 2,
      env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
    });
    if (processResult.aborted || request.signal?.aborted) {
      return { status: "cancelled", output: "", error: null, durationMs: processResult.durationMs, retryable: false };
    }
    const diagnostics = [processResult.stderr, processResult.stdout].filter(Boolean).join("\n").trim();
    if (processResult.exitCode !== 0 || !processResult.stdout.trim()) {
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
        isRetryableFailureCategory(category),
        processResult.durationMs,
        retryAfterMsForFailure(category)
      );
    }
    return {
      status: "completed",
      output: processResult.stdout.trim(),
      error: null,
      durationMs: processResult.durationMs,
      retryable: false
    };
  }

  private cacheHealth(health: AgentHealth, ttlMs: number) {
    this.cachedHealth = health;
    this.healthExpiresAt = Date.now() + ttlMs;
  }
}

export function buildAntigravityArgs(
  request: AgentExecutionRequest,
  model: string | null = null,
  effort: "low" | "medium" | "high" = "medium",
  printTimeoutMs = 8 * 60 * 60_000
): string[] {
  const writable = isWritableExecution(request);
  return [
    "--print",
    buildAgentGoalPrompt(request),
    "--output-format",
    "text",
    "--mode",
    writable ? "accept-edits" : "plan",
    "--effort",
    effort,
    "--sandbox",
    "--disable-slash-commands",
    "--add-dir",
    request.task.worktreePath || request.project.path,
    "--print-timeout",
    `${Math.ceil(printTimeoutMs / 1_000)}s`,
    ...(model ? ["--model", model] : [])
  ];
}

export function resolveAntigravityExecutable(explicitPath?: string): string | null {
  if (explicitPath) {
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : null,
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "agy") : null
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  try {
    const cmd = process.platform === "win32" ? "agy.exe" : "agy";
    const res = spawnSync(cmd, ["--version"], { windowsHide: true, timeout: 3_000 });
    if (res.status === 0) return cmd;
  } catch {}
  return null;
}

function failure(detail: string, category: FailureCategory = "offline"): AgentExecutionResult {
  return {
    outcome: "failed",
    summary: detail,
    structuredPayload: null,
    failureCategory: category,
    retryable: false,
    artifactsProduced: [],
    output: "",
    error: detail,
    durationMs: 0
  };
}

function processRuntime(result: AgentProcessResult): NonNullable<AgentExecutionResult["processRuntime"]> {
  return { breakerReason: result.breakerReason, outputStats: result.outputStats };
}

function improvementFailure(
  error: string,
  retryable: boolean,
  durationMs = 0,
  retryAfterMs?: number
): ImprovementReviewExecutionResult {
  return {
    status: "failed",
    output: "",
    error: redactSensitiveText(error).slice(0, 2_000),
    durationMs,
    retryable,
    retryAfterMs
  };
}
