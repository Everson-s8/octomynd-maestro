import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRecord, TaskRecord, TaskReviewStatus } from "../db.js";
import { AgentProcessResult, buildRestrictedAgentEnvironment, runAgentProcess } from "./process.js";
import {
  buildFailureSummary,
  classifyFailure,
  isRetryableFailureCategory,
  retryAfterMsForFailure
} from "./failure.js";
import {
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
import { isWritableExecution } from "./execution-policy.js";
import { withRemediation } from "./remediation.js";
import {
  DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS,
  normalizeProviderExecutionLimits,
  ProviderExecutionLimits
} from "./execution-limits.js";
import { buildAgentGoalPrompt, buildConversationPrompt, parseFinalReviewDecision } from "./goal-prompt.js";
import { buildReviewPrompt } from "./review-prompt.js";

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

const CLAUDE_CAPABILITIES = new Set<AgentCapability>([
  "planning",
  "coding",
  "testing",
  "reviewing",
  "improvement_reviewing",
  "research",
  "conversation"
]);

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const REVIEW_TOOLS = [...READ_ONLY_TOOLS, "Bash"];
const REVIEW_ALLOWED_TOOLS = [
  ...READ_ONLY_TOOLS,
  "Bash(git diff*)",
  "Bash(git status*)",
  "Bash(git log*)",
  "Bash(git show*)"
];
const CODING_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"];
const TESTING_TOOLS = [...CODING_TOOLS, "Bash"];
const TESTING_ALLOWED_TOOLS = [
  ...CODING_TOOLS,
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(npm test*)",
  "Bash(npx vitest*)",
  "Bash(pytest*)",
  "Bash(python -m pytest*)",
  "Bash(cargo test*)",
  "Bash(go test*)"
];
const DISALLOWED_MUTATIONS = [
  "Bash(git commit*)",
  "Bash(git push*)",
  "Bash(git reset --hard*)",
  "Bash(git clean*)",
  "Bash(gh*)",
  "Bash(npm publish*)",
  "Bash(pnpm publish*)",
  "Bash(yarn npm publish*)",
  "Bash(docker push*)",
  "Bash(kubectl apply*)",
  "Bash(kubectl rollout*)",
  "Bash(terraform apply*)",
  "Bash(vercel*)",
  "Bash(netlify*)",
  "Bash(aws*)",
  "Bash(az*)",
  "Bash(gcloud*)",
  "Bash(curl*)",
  "Bash(wget*)"
];

export type ClaudeProviderOptions = Partial<ProviderExecutionLimits> & {
  model?: string | null;
  executionLimits?: number | Partial<ProviderExecutionLimits>;
};

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly model: string | null;
  private cachedHealth: AgentHealth | null = null;
  private healthExpiresAt = 0;

  readonly executionLimits: ProviderExecutionLimits;

  constructor(options?: number | Partial<ProviderExecutionLimits> | ClaudeProviderOptions) {
    if (typeof options === "number") {
      this.model = null;
      this.executionLimits = normalizeProviderExecutionLimits(options, DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS);
    } else if (typeof options === "object" && options !== null) {
      const opts = options as ClaudeProviderOptions;
      this.model = opts.model?.trim() || null;
      const limits = opts.executionLimits !== undefined ? opts.executionLimits : options;
      this.executionLimits = normalizeProviderExecutionLimits(limits, DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS);
    } else {
      this.model = null;
      this.executionLimits = normalizeProviderExecutionLimits(undefined, DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS);
    }
  }

  async models(): Promise<string[]> {
    // Claude CLI does not expose a simple `models` subcommand; keep a current
    // list of supported model IDs (kept in sync with Anthropic's lineup).
    return [
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "claude-3-5-haiku",
      "claude-sonnet-4",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude"
    ];
  }

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const cli = resolveClaudeCliCommand();
    const envKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
    const oauth = readClaudeOAuthToken();
    const health: AgentHealth = envKey
      ? { state: "ready", detail: "Claude API Key disponivel via ENV", checkedAt: new Date().toISOString() }
      : !cli
        ? {
          state: "offline",
          detail: withRemediation("claude", "offline", "Claude CLI ou API Key nao encontrado."),
          checkedAt: new Date().toISOString()
        }
        : oauth
          ? { state: "ready", detail: "Claude CLI autenticado", checkedAt: new Date().toISOString() }
          : { state: "auth_required", detail: "Claude CLI instalado, mas a conta ainda nao foi autenticada.", checkedAt: new Date().toISOString() };
    this.cacheHealth(health, 30_000);
    return health;
  }

  refresh(): void {
    this.cachedHealth = null;
    this.healthExpiresAt = 0;
  }

  invalidateCaches(): void {
    this.refresh();
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const selectedModel = request.model ?? this.model;
    const result = await executeClaudeGoal(request, this.executionLimits, selectedModel);
    if (result.aborted || request.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: "Claude execution cancelled by user.",
        structuredPayload: null,
        artifactsProduced: [],
        output: "",
        error: null,
        durationMs: result.durationMs,
        retryable: false,
        processRuntime: processRuntime(result),
        model: selectedModel ?? "claude"
      };
    }
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const errorText = [
        result.stderr,
        result.stdout,
        result.breakerReason ? `process breaker: ${result.breakerReason}` : ""
      ].filter(Boolean).join("\n").trim();
      const category = classifyFailure(errorText, {
        provider: this.id,
        phase: request.phase,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        breakerReason: result.breakerReason,
        spawnErrorCode: result.spawnErrorCode
      });
      const retryable = isRetryableFailureCategory(category);
      const summary = buildFailureSummary(this.label, request.phase, category);
      if (category === "auth_required" || category === "quota") {
        this.cacheHealth({
          state: category,
          detail: withRemediation("claude", category, summary),
          checkedAt: new Date().toISOString()
        }, 10 * 60_000);
      } else if (category === "timeout") {
        this.cacheHealth({
          state: "ready",
          detail: "Claude CLI disponivel; a ultima execucao atingiu o limite de tempo.",
          checkedAt: new Date().toISOString()
        }, 15_000);
      } else {
        this.cacheHealth({
          state: "offline",
          detail: summary,
          checkedAt: new Date().toISOString()
        }, 30_000);
      }
      return {
        outcome: "failed",
        summary,
        structuredPayload: null,
        failureCategory: category,
        retryable,
        retryAfterMs: retryAfterMsForFailure(category),
        artifactsProduced: [],
        output: errorText,
        error: errorText || summary,
        durationMs: result.durationMs,
        processRuntime: processRuntime(result),
        tokenUsage: result.tokenUsage,
        model: selectedModel ?? "claude"
      };
    }

    this.cacheHealth({
      state: "ready",
      detail: "Claude CLI autenticado",
      checkedAt: new Date().toISOString()
    }, 30_000);
    const content = result.stdout.trim();
    const reviewDecision = request.phase === "reviewing" ? parseClaudeReviewDecision(content) : null;
    const requestsChanges = request.phase === "reviewing" && reviewDecision !== "approved";
    return {
      outcome: requestsChanges ? "changes_requested" : "completed",
      summary: requestsChanges
        ? reviewDecision === "changes_requested"
          ? "Claude solicitou ajustes concretos."
          : "Claude nao aprovou explicitamente a revisao final."
        : `Claude concluiu a fase ${request.phase}.`,
      structuredPayload: request.phase === "reviewing" ? { reviewDecision } : { phase: request.phase },
      artifactsProduced: [],
      output: content,
      error: null,
      durationMs: result.durationMs,
      retryable: false,
      processRuntime: processRuntime(result),
      tokenUsage: result.tokenUsage,
      model: selectedModel ?? "claude"
    };
  }

  async reviewImprovements(
    request: ImprovementReviewExecutionRequest
  ): Promise<ImprovementReviewExecutionResult> {
    const startedAt = Date.now();
    const cli = resolveClaudeCliCommand();
    if (!cli) return improvementFailure("Claude Code CLI was not found.", startedAt, false);
    if (!fs.existsSync(request.workspacePath)) {
      return improvementFailure(`Workspace nao existe: ${request.workspacePath}`, startedAt, false);
    }
    const result = await runAgentProcess({
      command: cli.command,
      args: buildClaudeImprovementReviewArgs(cli, request, this.model),
      cwd: request.workspacePath,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      maxOutputChars: request.maxOutputChars,
      maxReceivedChars: request.maxOutputChars * 2,
      env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
    });
    if (result.aborted || request.signal?.aborted) {
      return {
        status: "cancelled",
        output: "",
        error: null,
        durationMs: result.durationMs,
        retryable: false
      };
    }
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const diagnostics = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      const category = classifyFailure(diagnostics, {
        provider: this.id,
        phase: "reviewing",
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        breakerReason: result.breakerReason,
        spawnErrorCode: result.spawnErrorCode
      });
      return improvementFailure(
        diagnostics || buildFailureSummary(this.label, "reviewing", category),
        startedAt,
        isRetryableFailureCategory(category),
        retryAfterMsForFailure(category)
      );
    }
    return {
      status: "completed",
      output: result.stdout.trim(),
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

function readClaudeOAuthToken(): string | null {
  const credentialsPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = raw.claudeAiOauth?.accessToken?.trim();
    return token || null;
  } catch {
    return null;
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
    buildReviewPrompt(task, project),
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--add-dir",
    cwd,
    "--no-session-persistence"
  ];

  const result = await runAgentProcess({
    command: cli.command,
    args,
    cwd,
    timeoutMs: 180_000,
    signal,
    env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
  });
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

export function buildClaudeGoalPrompt(request: AgentExecutionRequest): string {
  return buildAgentGoalPrompt(request);
}

export function buildClaudeGoalArgs(
  cli: ClaudeCliCommand,
  request: AgentExecutionRequest,
  cwd: string,
  model?: string | null
): string[] {
  if (request.capability === "conversation") {
    return [
      ...cli.argsPrefix,
      "--print",
      "--output-format",
      "text",
      "--permission-mode",
      "plan",
      "--tools",
      READ_ONLY_TOOLS.join(","),
      "--add-dir",
      cwd,
      "--no-session-persistence",
      ...(model ? ["--model", model] : []),
      buildConversationPrompt(request)
    ];
  }
  const writable = isWritableExecution(request);
  const testing = request.capability === "testing";
  const reviewing = request.capability === "reviewing";
  const tools = testing
    ? writable ? TESTING_TOOLS : REVIEW_TOOLS
    : writable ? CODING_TOOLS : reviewing ? REVIEW_TOOLS : READ_ONLY_TOOLS;
  const allowedTools = testing
    ? writable ? TESTING_ALLOWED_TOOLS : TESTING_ALLOWED_TOOLS.filter((tool) => !["Edit", "Write"].includes(tool))
    : reviewing ? REVIEW_ALLOWED_TOOLS : CODING_TOOLS;
  return [
    ...cli.argsPrefix,
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    writable ? "acceptEdits" : "plan",
    "--tools",
    tools.join(","),
    ...(testing || writable || reviewing
      ? ["--allowedTools", allowedTools.join(","), "--disallowedTools", ...DISALLOWED_MUTATIONS]
      : []),
    "--add-dir",
    cwd,
    "--no-session-persistence",
    ...(model ? ["--model", model] : []),
    buildClaudeGoalPrompt(request)
  ];
}

export function buildClaudeImprovementReviewArgs(
  cli: ClaudeCliCommand,
  request: ImprovementReviewExecutionRequest,
  model?: string | null
): string[] {
  return [
    ...cli.argsPrefix,
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    "plan",
    "--tools",
    READ_ONLY_TOOLS.join(","),
    "--add-dir",
    request.workspacePath,
    "--no-session-persistence",
    ...(model ? ["--model", model] : []),
    request.prompt
  ];
}

export function parseClaudeReviewDecision(content: string): "approved" | "changes_requested" | null {
  return parseFinalReviewDecision(content);
}

export function buildClaudeCliCommand(cliEntry: string): ClaudeCliCommand {
  return cliEntry.toLowerCase().endsWith(".js")
    ? { command: process.execPath, argsPrefix: [cliEntry] }
    : { command: cliEntry, argsPrefix: [] };
}

export function isClaudeAuthenticationError(errorText: string): boolean {
  return /401|authentication|credentials|not logged in|please run \/login|sign in/i.test(errorText);
}

export function isClaudeQuotaError(errorText: string): boolean {
  return /session limit|usage limit|rate limit|quota|resets? at/i.test(errorText);
}

async function executeClaudeGoal(
  request: AgentExecutionRequest,
  limits: ProviderExecutionLimits,
  model?: string | null
) {
  const cwd = request.task.worktreePath || request.project.path;
  const cli = resolveClaudeCliCommand();
  if (!cli || !fs.existsSync(cwd)) {
    return {
      exitCode: null,
      stdout: "",
      stderr: !cli ? "Claude Code CLI was not found." : `Task workspace does not exist: ${cwd}`,
      aborted: false,
      timedOut: false,
      breakerReason: null,
      outputStats: { receivedChars: 0, retainedChars: 0, duplicateChunks: 0, truncatedChars: 0 },
      durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 }
    };
  }
  return runAgentProcess({
    command: cli.command,
    args: buildClaudeGoalArgs(cli, request, cwd, model),
    cwd,
    provider: "claude",
    timeoutMs: limits.maxRuntimeMs,
    // Claude --print commonly buffers the response until completion, so its
    // inactivity window is intentionally longer than Codex's streaming window.
    inactivityTimeoutMs: limits.inactivityTimeoutMs,
    deadlineAt: request.deadlineAt,
    signal: request.signal,
    env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true })
  });
}

function processRuntime(result: AgentProcessResult): NonNullable<AgentExecutionResult["processRuntime"]> {
  return { breakerReason: result.breakerReason, outputStats: result.outputStats };
}

export function resolveClaudeCliCommand(): ClaudeCliCommand | null {
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
  if (cliEntry) return buildClaudeCliCommand(cliEntry);

  try {
    const cmd = process.platform === "win32" ? "claude.exe" : "claude";
    // Same rationale as codex: slow cold-start probes must not flip the card.
    const res = spawnSync(cmd, ["--version"], { windowsHide: true, timeout: 10_000 });
    if (res.status === 0) return buildClaudeCliCommand(cmd);
  } catch {}
  return null;
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
