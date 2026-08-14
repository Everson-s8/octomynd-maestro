import type { ProjectRecord, TaskRecord, TaskReviewStatus } from "../db.js";
import type { AgentLease } from "./registry.js";
import type { AgentCapability, AgentExecutionRequest, AgentExecutionResult } from "./types.js";

/**
 * Provider-agnostic manual review orchestration.
 *
 * The manual "review this task" action must honour the routing policy the user
 * configured for the `reviewing` capability — NOT hardcode a single provider.
 * This mirrors exactly what the goal runner does: acquire the provider that the
 * policy routed to `reviewing`, execute a read-only review step through it, and
 * release the lease.
 *
 * If Claude (or any other single provider) is disconnected, the review still
 * runs on whatever enabled, ready provider the user selected for review.
 */

export type ProviderReviewResult = {
  status: TaskReviewStatus;
  provider: string;
  content: string;
  error: string | null;
  durationMs: number;
};

/** Structural minimum the orchestrator needs from the agent registry. */
export type ReviewAcquirer = {
  acquire(capability: AgentCapability, excluded?: ReadonlySet<string>): Promise<AgentLease | null>;
};

function mapOutcome(result: AgentExecutionResult): TaskReviewStatus {
  if (result.outcome === "completed" || result.outcome === "changes_requested") return "completed";
  return "failed";
}

export async function runProviderReview(
  registry: ReviewAcquirer,
  task: TaskRecord,
  project: ProjectRecord,
  signal?: AbortSignal
): Promise<ProviderReviewResult> {
  const startedAt = Date.now();

  const lease = await registry.acquire("reviewing");
  if (!lease) {
    return {
      status: "failed",
      provider: "maestro",
      content: "",
      error: "Nenhum provider habilitado e pronto para revisao.",
      durationMs: Date.now() - startedAt
    };
  }

  try {
    const request: AgentExecutionRequest = {
      runId: 0,
      stepNumber: 1,
      phase: "reviewing",
      capability: "reviewing",
      task,
      project,
      previousSteps: [],
      artifactsRoot: project.path,
      signal
    };

    const result = await lease.provider.execute(request);
    const providerId = lease.provider.id;
    const status = mapOutcome(result);

    lease.release({
      retryable: result.retryable,
      summary: result.summary,
      failureCategory: result.failureCategory
    });

    return {
      status,
      provider: providerId,
      content: result.output,
      error: status === "failed" ? result.error ?? result.summary : null,
      durationMs: result.durationMs || Date.now() - startedAt
    };
  } catch (error) {
    lease.release();
    return {
      status: "failed",
      provider: "maestro",
      content: "",
      error: error instanceof Error ? error.message : "Unknown review execution error.",
      durationMs: Date.now() - startedAt
    };
  }
}
