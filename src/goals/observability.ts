import { MaestroDatabase, GoalRunRecord, GoalWaitReason } from "../db.js";
import { classifyFailure, failureCategoryLabel, FailureCategory, isRetryableFailureCategory } from "../agents/failure.js";
import { redactSensitiveText } from "../security/redaction.js";

export type GoalObservabilitySnapshot = {
  classifiedReason: string | null;
  classifiedReasonLabel: string | null;
  sourceProvider: string | null;
  nextProvider: string | null;
  preservedChanges: boolean;
  preservedFiles: string[];
  checkpointId: number | null;
  retryable: boolean;
  nextAction: string;
};

const WAIT_REASON_LABELS: Record<string, string> = {
  quota: "provider quota exhausted",
  auth_required: "authentication required",
  timeout: "time limit exceeded",
  output_limit: "provider output limit reached",
  offline: "provider unavailable",
  capacity: "no provider with available capacity",
  runtime_restart: "Maestro runtime restart",
  budget_exhausted: "Goal step budget exhausted",
  small_task_failure_limit: "repeated small-task failure; scope should be reduced",
  task_split_required: "consecutive failures; task should be split into smaller sub-tasks",
  prompt_too_large: "prompt size exceeded (ENAMETOOLONG/E2BIG)",
  unknown: "unknown provider error"
};

export function formatReasonLabel(reason: string): string {
  return WAIT_REASON_LABELS[reason] ?? failureCategoryLabel(reason as FailureCategory);
}

export function buildGoalObservability(
  database: MaestroDatabase,
  goal: GoalRunRecord
): GoalObservabilitySnapshot {
  const latestCheckpoint = database.getLatestGoalCheckpoint(goal.id);
  const events = database.listEvents(100).filter((e) => e.taskId === goal.taskId);
  const fallbackEvent = events.find((e) => e.type === "goal.provider_fallback" && e.metadata?.runId === goal.id);
  const waitEvent = events.find((e) => e.type === "goal.waiting_provider" && e.metadata?.runId === goal.id);
  const terminalEvent = events.find((e) => (e.type === "goal.blocked" || e.type === "goal.failed") && e.metadata?.runId === goal.id);

  const rawReason = goal.waitReason
    ?? (fallbackEvent?.metadata?.failureCategory as string)
    ?? (waitEvent?.metadata?.waitReason as string)
    ?? (terminalEvent?.metadata?.failureCategory as string)
    ?? (goal.lastError ? classifyFailure(goal.lastError) : null);

  const classifiedReason = rawReason ?? null;
  const classifiedReasonLabel = classifiedReason ? formatReasonLabel(classifiedReason) : null;

  const sourceProvider = classifiedReason === "budget_exhausted" ? null : (fallbackEvent?.metadata?.fromProvider as string | undefined)
    ?? (waitEvent?.metadata?.fromProvider as string | undefined)
    ?? (terminalEvent?.metadata?.lastProvider as string | undefined)
    ?? goal.lastProvider
    ?? null;

  const terminal = goal.status === "blocked"
    || goal.status === "failed"
    || goal.status === "completed"
    || goal.status === "cancelled";
  const nextProvider = terminal
    ? null
    : (fallbackEvent?.metadata?.toProvider as string | undefined)
      ?? (waitEvent?.metadata?.toProvider as string | undefined)
      ?? (waitEvent?.metadata?.provider as string | undefined)
      ?? null;

  const checkpointId = latestCheckpoint?.id
    ?? (fallbackEvent?.metadata?.resumeCheckpointId as number)
    ?? (waitEvent?.metadata?.resumeCheckpointId as number)
    ?? (terminalEvent?.metadata?.resumeCheckpointId as number)
    ?? null;

  const preservedFiles = latestCheckpoint?.changedFiles
    ?? (fallbackEvent?.metadata?.preservedFiles as string[])
    ?? (waitEvent?.metadata?.preservedFiles as string[])
    ?? (terminalEvent?.metadata?.preservedFiles as string[])
    ?? [];

  const preservedChanges = preservedFiles.length > 0 || Boolean(latestCheckpoint);

  const retryable = goal.status === "waiting_provider"
    || Boolean(fallbackEvent?.metadata?.retryable)
    || (classifiedReason === "budget_exhausted"
      ? false
      : classifiedReason ? isRetryableFailureCategory(classifiedReason as FailureCategory) : false);

  const nextAction = determineNextAction({
    status: goal.status,
    waitReason: classifiedReason,
    nextRetryAt: goal.nextRetryAt ?? null,
    nextProvider,
    retryable,
    fromProvider: sourceProvider
  });

  return {
    classifiedReason,
    classifiedReasonLabel,
    sourceProvider,
    nextProvider,
    preservedChanges,
    preservedFiles,
    checkpointId,
    retryable,
    nextAction
  };
}

function determineNextAction(input: {
  status: string;
  waitReason: string | null;
  nextRetryAt: string | null;
  nextProvider: string | null;
  retryable: boolean;
  fromProvider: string | null;
}): string {
  if (input.status === "completed") {
    return "Goal completed successfully.";
  }
  if (input.status === "cancelled") {
    return "Goal cancelled by the user.";
  }
  if (input.status === "running") {
    if (input.fromProvider && input.nextProvider && input.fromProvider !== input.nextProvider) {
      return `Automatic handoff from ${input.fromProvider} to ${input.nextProvider}.`;
    }
    return "Executing the next goal step.";
  }
  if (input.status === "waiting_provider") {
    if (input.nextRetryAt) {
      const timeStr = formatRetryTime(input.nextRetryAt);
      return `Automatic resume scheduled for ${timeStr}.`;
    }
    if (input.nextProvider) {
      return `Waiting for provider ${input.nextProvider} to become available.`;
    }
    return "Waiting for provider quota or capacity.";
  }
  if (input.retryable) {
    return "A transient failure was detected. Maestro scheduled another attempt.";
  }
  if (input.waitReason === "budget_exhausted") {
    return "The preserved work reached the Goal step limit. Resume from the checkpoint or increase the budget after reviewing the scope.";
  }
  return "Permanent interruption. Manual intervention or a provider policy change is required.";
}

function formatRetryTime(nextRetryAt: string): string {
  const date = new Date(nextRetryAt);
  if (!Number.isFinite(date.getTime())) return nextRetryAt;
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
