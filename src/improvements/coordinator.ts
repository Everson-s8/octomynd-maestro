import { AgentRegistry } from "../agents/registry.js";
import type { AgentProviderId } from "../agents/types.js";
import { redactSensitiveText } from "../security/redaction.js";
import {
  buildImprovementReviewPrompt,
  buildImprovementReviewSchema,
  IMPROVEMENT_REVIEW_DEFAULT_MAX_CANDIDATES,
  IMPROVEMENT_REVIEW_DEFAULT_MAX_OUTPUT_CHARS,
  IMPROVEMENT_REVIEW_DEFAULT_TIMEOUT_MS,
  IMPROVEMENT_REVIEW_MAX_ATTEMPTS,
  IMPROVEMENT_REVIEW_MAX_CANDIDATES,
  IMPROVEMENT_REVIEW_MAX_OUTPUT_CHARS,
  IMPROVEMENT_REVIEW_MAX_TIMEOUT_MS,
  ImprovementEvidencePack,
  ImprovementReviewAttempt,
  ImprovementReviewExecutionRequest,
  ImprovementReviewExecutionResult,
  ImprovementReviewResult,
  parseImprovementCandidateDrafts,
  RestrictedImprovementReviewer
} from "./reviewer.js";

export type RestrictedImprovementReviewOptions = {
  timeoutMs?: number;
  maxOutputChars?: number;
  maxCandidates?: number;
};

export class RestrictedImprovementReviewCoordinator implements RestrictedImprovementReviewer {
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly maxCandidates: number;

  constructor(
    private readonly agents: AgentRegistry,
    options: RestrictedImprovementReviewOptions = {}
  ) {
    this.timeoutMs = boundedPositiveInteger(
      options.timeoutMs,
      IMPROVEMENT_REVIEW_DEFAULT_TIMEOUT_MS,
      IMPROVEMENT_REVIEW_MAX_TIMEOUT_MS
    );
    this.maxOutputChars = boundedPositiveInteger(
      options.maxOutputChars,
      IMPROVEMENT_REVIEW_DEFAULT_MAX_OUTPUT_CHARS,
      IMPROVEMENT_REVIEW_MAX_OUTPUT_CHARS
    );
    this.maxCandidates = boundedPositiveInteger(
      options.maxCandidates,
      IMPROVEMENT_REVIEW_DEFAULT_MAX_CANDIDATES,
      IMPROVEMENT_REVIEW_MAX_CANDIDATES
    );
  }

  async review(
    evidencePack: ImprovementEvidencePack,
    options: { workspacePath: string; signal?: AbortSignal }
  ): Promise<ImprovementReviewResult> {
    const schema = buildImprovementReviewSchema(this.maxCandidates);
    const prompt = buildImprovementReviewPrompt(evidencePack, schema);
    const excluded = new Set<AgentProviderId>();
    const attempts: ImprovementReviewAttempt[] = [];

    while (attempts.length < IMPROVEMENT_REVIEW_MAX_ATTEMPTS) {
      if (options.signal?.aborted) return { status: "cancelled", candidates: [], attempts };
      const lease = await this.agents.acquire("improvement_reviewing", excluded);
      if (!lease) {
        return { status: attempts.length === 0 ? "unavailable" : "failed", candidates: [], attempts };
      }
      excluded.add(lease.provider.id);
      const request: ImprovementReviewExecutionRequest = {
        workspacePath: options.workspacePath,
        prompt,
        schema,
        timeoutMs: this.timeoutMs,
        maxOutputChars: this.maxOutputChars,
        signal: options.signal
      };
      let execution: ImprovementReviewExecutionResult;
      try {
        execution = await executeWithDeadline(lease.provider.reviewImprovements, request, lease.provider.id);
      } catch (error) {
        execution = {
          status: options.signal?.aborted ? "cancelled" : "failed",
          output: "",
          error: safeError(error),
          durationMs: 0,
          retryable: true
        };
      }
      lease.release({
        retryable: execution.retryable,
        retryAfterMs: execution.retryAfterMs,
        summary: execution.error ?? "Improvement review provider failure."
      });

      if (execution.status === "cancelled" || options.signal?.aborted) {
        attempts.push(attempt(lease.provider.id, "cancelled", execution));
        return { status: "cancelled", candidates: [], attempts };
      }
      if (execution.status === "failed") {
        attempts.push(attempt(lease.provider.id, "failed", execution));
        continue;
      }
      if (execution.output.length > this.maxOutputChars) {
        attempts.push({
          provider: lease.provider.id,
          status: "invalid",
          error: "Provider output exceeded the configured limit.",
          durationMs: execution.durationMs
        });
        continue;
      }
      const candidates = parseImprovementCandidateDrafts(execution.output, evidencePack, this.maxCandidates);
      if (candidates === null) {
        attempts.push({
          provider: lease.provider.id,
          status: "invalid",
          error: "Provider returned invalid improvement candidate output.",
          durationMs: execution.durationMs
        });
        continue;
      }
      attempts.push(attempt(lease.provider.id, "completed", execution));
      return { status: "completed", candidates, attempts };
    }

    return { status: "failed", candidates: [], attempts };
  }
}

function attempt(
  provider: AgentProviderId,
  status: ImprovementReviewAttempt["status"],
  execution: ImprovementReviewExecutionResult
): ImprovementReviewAttempt {
  return { provider, status, error: execution.error, durationMs: execution.durationMs };
}

function missingAdapterResult(provider: AgentProviderId): ImprovementReviewExecutionResult {
  return {
    status: "failed",
    output: "",
    error: `Provider ${provider} does not implement restricted improvement review.`,
    durationMs: 0,
    retryable: false
  };
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? redactSensitiveText(error.message).slice(0, 500)
    : "Improvement review provider failed.";
}

async function executeWithDeadline(
  review: ((request: ImprovementReviewExecutionRequest) => Promise<ImprovementReviewExecutionResult>) | undefined,
  request: ImprovementReviewExecutionRequest,
  provider: AgentProviderId
): Promise<ImprovementReviewExecutionResult> {
  if (!review) return missingAdapterResult(provider);
  const controller = new AbortController();
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<ImprovementReviewExecutionResult>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        status: "failed",
        output: "",
        error: "Improvement review provider timed out.",
        durationMs: Date.now() - startedAt,
        retryable: true
      });
      controller.abort();
    }, request.timeoutMs);
    abortListener = () => {
      resolve({
        status: "cancelled",
        output: "",
        error: null,
        durationMs: Date.now() - startedAt,
        retryable: false
      });
      controller.abort();
    };
    request.signal?.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([
      review({ ...request, signal: controller.signal }),
      deadline
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener) request.signal?.removeEventListener("abort", abortListener);
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? Math.min(value!, maximum) : fallback;
}
