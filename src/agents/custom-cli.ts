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
  AgentProvider,
  AgentProviderId,
  CustomCliProviderConfig
} from "./types.js";
import type {
  ImprovementReviewExecutionRequest,
  ImprovementReviewExecutionResult
} from "../improvements/reviewer.js";
import { redactSensitiveText } from "../security/redaction.js";

export type CustomCliProviderOptions = {
  model?: string | null;
  executionLimits?: number | Partial<ProviderExecutionLimits>;
};

export class CustomCliProvider implements AgentProvider {
  readonly id: AgentProviderId;
  readonly label: string;
  readonly capabilities: ReadonlySet<AgentCapability>;
  readonly model: string | null;
  private readonly config: CustomCliProviderConfig;
  private readonly executionLimits: ProviderExecutionLimits;
  private cachedHealth: AgentHealth | null = null;
  private healthExpiresAt = 0;

  constructor(
    config: CustomCliProviderConfig,
    options: CustomCliProviderOptions = {}
  ) {
    this.config = config;
    this.id = config.id as AgentProviderId;
    this.label = config.label || config.id;
    this.capabilities = new Set(config.capabilities);
    this.model = options.model?.trim() || config.model?.trim() || null;
    this.executionLimits = normalizeProviderExecutionLimits(
      options.executionLimits,
      DEFAULT_ANTIGRAVITY_INACTIVITY_TIMEOUT_MS
    );
  }

  async models(): Promise<string[]> {
    if (this.config.models && this.config.models.length > 0) {
      return this.config.models;
    }
    return this.model ? [this.model] : [this.id];
  }

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const executable = resolveCustomCliExecutable(this.config.command);
    const envKeyPresent = Boolean(
      this.config.envKeys?.some((key) => Boolean(process.env[key]?.trim()))
    );

    let health: AgentHealth;
    if (!executable && !envKeyPresent) {
      health = {
        state: "offline",
        detail: `${this.label} CLI ou chave ENV nao encontrada`,
        checkedAt: new Date().toISOString()
      };
    } else if (this.config.healthProbe && executable) {
      const probeArgs = this.config.args && this.config.args.length > 0 ? this.config.args : ["--version"];
      const probe = await runAgentProcess({
        command: executable,
        args: probeArgs,
        cwd: process.cwd(),
        timeoutMs: 15_000,
        inactivityTimeoutMs: 15_000,
        maxOutputChars: 20_000,
        env: buildRestrictedAgentEnvironment(process.env, {
          extraAllowedKeys: this.config.envKeys
        })
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

      if (category === "auth_required") {
        health = { state: "auth_required", detail: `${this.label} precisa de autenticacao.`, checkedAt: new Date().toISOString() };
      } else if (probe.exitCode === 0) {
        health = { state: "ready", detail: `${this.label} CLI disponivel`, checkedAt: new Date().toISOString() };
      } else {
        health = { state: "offline", detail: `${this.label} CLI probe indisponivel.`, checkedAt: new Date().toISOString() };
      }
    } else {
      health = executable
        ? { state: "ready", detail: `${this.label} CLI disponivel`, checkedAt: new Date().toISOString() }
        : { state: "offline", detail: `${this.label} CLI nao encontrado.`, checkedAt: new Date().toISOString() };
    }

    this.cacheHealth(health, 30_000);
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const executable = resolveCustomCliExecutable(this.config.command);
    const cwd = request.task.worktreePath || request.project.path;
    const selectedModel = request.model ?? this.model;

    if (!executable) {
      return failure(`${this.label} CLI nao encontrado: ${this.config.command}`);
    }
    const cmdToRun = executable;

    if (!fs.existsSync(cwd)) {
      return failure(`Workspace nao existe: ${cwd}`);
    }

    const processResult = await runAgentProcess({
      command: cmdToRun,
      args: buildCustomCliArgs(request, this.config, undefined, selectedModel),
      cwd,
      provider: this.id,
      timeoutMs: this.executionLimits.maxRuntimeMs,
      inactivityTimeoutMs: this.executionLimits.inactivityTimeoutMs,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
      env: buildRestrictedAgentEnvironment(process.env, {
        extraAllowedKeys: this.config.envKeys
      })
    });

    if (processResult.aborted || request.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: `${this.label} execution cancelled by user.`,
        structuredPayload: null,
        artifactsProduced: [],
        output: "",
        error: null,
        durationMs: processResult.durationMs,
        retryable: false,
        processRuntime: processRuntime(processResult),
        tokenUsage: processResult.tokenUsage,
        model: selectedModel ?? this.id
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
      }
      return {
        outcome: "failed",
        summary,
        structuredPayload: null,
        failureCategory: category,
        retryable: isRetryableFailureCategory(category),
        retryAfterMs: retryAfterMsForFailure(category),
        artifactsProduced: [],
        output: redactSensitiveText(diagnostics),
        error: redactSensitiveText(diagnostics || summary),
        durationMs: processResult.durationMs,
        processRuntime: processRuntime(processResult),
        tokenUsage: processResult.tokenUsage,
        model: selectedModel ?? this.id
      };
    }

    this.cacheHealth({
      state: "ready",
      detail: `${this.label} CLI disponivel`,
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
          ? `${this.label} solicitou ajustes concretos.`
          : `${this.label} nao aprovou explicitamente a revisao final.`
        : `${this.label} concluiu a fase ${request.phase}.`,
      structuredPayload: request.phase === "reviewing" ? { reviewDecision } : { phase: request.phase },
      artifactsProduced: [],
      output: redactSensitiveText(output),
      error: null,
      durationMs: processResult.durationMs,
      retryable: false,
      processRuntime: processRuntime(processResult),
      tokenUsage: processResult.tokenUsage,
      model: selectedModel ?? this.id
    };
  }

  async reviewImprovements(
    request: ImprovementReviewExecutionRequest
  ): Promise<ImprovementReviewExecutionResult> {
    const executable = resolveCustomCliExecutable(this.config.command);
    if (!executable || !fs.existsSync(request.workspacePath)) {
      const error = !executable
        ? `${this.label} CLI nao encontrado.`
        : `Workspace nao existe: ${request.workspacePath}`;
      return improvementFailure(error, false);
    }
    const processResult = await runAgentProcess({
      command: executable,
      args: [
        ...(this.config.args ?? []),
        "--print",
        request.prompt,
        "--output-format",
        "text",
        "--mode",
        "plan",
        "--sandbox",
        "--add-dir",
        request.workspacePath,
        "--print-timeout",
        `${Math.ceil(request.timeoutMs / 1_000)}s`,
        ...(this.model ? ["--model", this.model] : [])
      ],
      cwd: request.workspacePath,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      maxOutputChars: request.maxOutputChars,
      maxReceivedChars: request.maxOutputChars * 2,
      env: buildRestrictedAgentEnvironment(process.env, {
        extraAllowedKeys: this.config.envKeys
      })
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
      output: redactSensitiveText(processResult.stdout.trim()),
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

export function buildCustomCliArgs(
  request: AgentExecutionRequest,
  config: CustomCliProviderConfig,
  printTimeoutMs = 8 * 60 * 60_000,
  model?: string | null
): string[] {
  const prompt = buildAgentGoalPrompt(request);
  const cwd = request.task.worktreePath || request.project.path;
  const writable = isWritableExecution(request);

  if (config.args && config.args.some((arg) => arg.includes("{prompt}"))) {
    return config.args.map((arg) =>
      arg.replace("{prompt}", prompt).replace("{cwd}", cwd).replace("{model}", model ?? "")
    );
  }

  const extraArgs = (config.args ?? []).map((arg) => arg.replace("{model}", model ?? ""));
  const hasModelArg = extraArgs.some((arg) => arg === "--model" || arg === "-m");
  return [
    "--print",
    prompt,
    "--output-format",
    "text",
    "--mode",
    writable ? "accept-edits" : "plan",
    "--sandbox",
    "--disable-slash-commands",
    "--add-dir",
    cwd,
    "--print-timeout",
    `${Math.ceil(printTimeoutMs / 1_000)}s`,
    ...extraArgs,
    ...(model && !hasModelArg ? ["--model", model] : [])
  ];
}

export function resolveCustomCliExecutable(command: string): string | null {
  if (!command || !command.trim()) return null;
  const cmd = command.trim();
  if (path.isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) {
    return fs.existsSync(cmd) ? cmd : null;
  }
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const fullPath = path.join(dir, cmd + ext);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  try {
    const res = spawnSync(cmd, ["--version"], { windowsHide: true, timeout: 3_000 });
    if (res.status === 0 || (res.error && (res.error as any).code !== "ENOENT")) {
      return cmd;
    }
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
