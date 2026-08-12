import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentExecutionResult } from "../agents/types.js";
import type { GoalPhase, GoalStepRecord } from "../db.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";

export type GoalCircuitBreakerReason =
  | "deadline"
  | "duplicate_output"
  | "output_limit"
  | "repeated_failure"
  | "no_progress"
  | "phase_budget_exhausted"
  | "small_task_failure_limit"
  | "task_split_required"
  | "prompt_too_large";

export type GoalCircuitBreakerDecision = {
  reason: GoalCircuitBreakerReason;
  summary: string;
};

export type GoalCircuitBreakerObservation = {
  phase: GoalPhase;
  result: AgentExecutionResult;
  workspaceBefore: string | null;
  workspaceAfter: string | null;
  taskText?: string;
  taskMetadata?: Record<string, any> | null;
};

const REPEATED_FAILURE_LIMIT = 2;
const NO_PROGRESS_LIMIT = 2;
const SUMMARY_MAX_LENGTH = 300;
const MAX_UNTRACKED_HASH_BYTES = 8_000_000;

export function isSmallTask(taskText: string, metadata?: Record<string, any> | null): boolean {
  if (metadata?.isSmallTask === true || metadata?.size === "small" || metadata?.complexity === "small") {
    return true;
  }
  if (metadata?.isSmallTask === false || metadata?.size === "large" || metadata?.complexity === "large") {
    return false;
  }
  const text = taskText.trim();
  if (!text) return false;
  return /\b(small task|task pequena|small change|pequena alteracao|small fix)\b/i.test(text);
}

export const DEFAULT_PHASE_BUDGETS: Record<GoalPhase, number> = {
  planning: 3,
  implementing: 6,
  testing: 4,
  reviewing: 3
};

export class GoalCircuitBreaker {
  private readonly repeatedFailures = new Map<string, number>();
  private readonly noProgress = new Map<GoalPhase, number>();
  private readonly phaseStepCounts = new Map<GoalPhase, number>();
  private readonly phaseBudgets: Record<GoalPhase, number>;
  private consecutiveFailures = 0;
  private totalFailures = 0;

  constructor(phaseBudgets?: Partial<Record<GoalPhase, number>>) {
    this.phaseBudgets = {
      ...DEFAULT_PHASE_BUDGETS,
      ...phaseBudgets
    };
  }

  static fromSteps(
    steps: GoalStepRecord[],
    phaseBudgets?: Partial<Record<GoalPhase, number>>
  ): GoalCircuitBreaker {
    const breaker = new GoalCircuitBreaker(phaseBudgets);
    for (const step of steps) {
      const count = (breaker.phaseStepCounts.get(step.phase) ?? 0) + 1;
      breaker.phaseStepCounts.set(step.phase, count);

      if (step.status === "failed") {
        breaker.totalFailures += 1;
        breaker.consecutiveFailures += 1;
        breaker.incrementFailure(failureFingerprint(step.phase, step.summary, step.error));
      } else if (step.status === "completed") {
        breaker.consecutiveFailures = 0;
      }
    }
    return breaker;
  }

  checkPhaseBudget(phase: GoalPhase): GoalCircuitBreakerDecision | null {
    const count = this.phaseStepCounts.get(phase) ?? 0;
    const limit = this.phaseBudgets[phase];
    if (limit !== undefined && count >= limit) {
      return decision(
        "phase_budget_exhausted",
        `Phase '${phase}' reached its limit of ${limit} steps.`
      );
    }
    return null;
  }

  observe(observation: GoalCircuitBreakerObservation): GoalCircuitBreakerDecision | null {
    const count = (this.phaseStepCounts.get(observation.phase) ?? 0) + 1;
    this.phaseStepCounts.set(observation.phase, count);

    const processReason = observation.result.processRuntime?.breakerReason;
    if (processReason === "deadline") {
      return decision("deadline", "Goal deadline reached during provider execution.");
    }
    if (processReason === "duplicate_output" || processReason === "output_limit") {
      return decision(processReason, `Provider stopped by ${processReason}; partial worktree preserved.`);
    }

    if (observation.result.failureCategory === "prompt_too_large") {
      return decision(
        "prompt_too_large",
        "Prompt size or argument list exceeded system limits (ENAMETOOLONG/E2BIG). Prompt-bloat detected."
      );
    }

    if (observation.result.outcome === "failed") {
      this.totalFailures += 1;
      this.consecutiveFailures += 1;

      const failureCount = this.incrementFailure(failureFingerprint(
        observation.phase,
        observation.result.summary,
        observation.result.error
      ));
      if (failureCount >= REPEATED_FAILURE_LIMIT) {
        return decision("repeated_failure", "The same provider failure repeated without useful recovery.");
      }

      const limit = this.phaseBudgets[observation.phase];
      if (limit !== undefined && count >= limit) {
        return decision(
          "phase_budget_exhausted",
          `Phase '${observation.phase}' reached its limit of ${limit} steps.`
        );
      }

      const small = isSmallTask(observation.taskText ?? "", observation.taskMetadata);
      if (small && this.consecutiveFailures >= 2) {
        return decision(
          "small_task_failure_limit",
          "Small task failed 2 consecutive times. Escalating and stopping retries with reduced scope."
        );
      }

      if (this.totalFailures >= 3) {
        return decision(
          "task_split_required",
          "Task failed 3 times across execution steps. Goal must be split into smaller sub-tasks instead of growing prompt."
        );
      }

      return null;
    }

    if (observation.result.outcome === "completed") {
      this.consecutiveFailures = 0;
    }

    if (
      observation.result.outcome === "completed"
      && (observation.phase === "implementing" || observation.phase === "testing")
      && observation.workspaceBefore !== null
      && observation.workspaceBefore === observation.workspaceAfter
    ) {
      const noProgressCount = (this.noProgress.get(observation.phase) ?? 0) + 1;
      this.noProgress.set(observation.phase, noProgressCount);
      if (noProgressCount >= NO_PROGRESS_LIMIT) {
        return decision("no_progress", `${observation.phase} completed repeatedly without changing the worktree.`);
      }
    } else if (observation.workspaceBefore !== observation.workspaceAfter) {
      this.noProgress.set(observation.phase, 0);
    }

    const limit = this.phaseBudgets[observation.phase];
    if (limit !== undefined && count >= limit) {
      return decision(
        "phase_budget_exhausted",
        `Phase '${observation.phase}' reached its limit of ${limit} steps.`
      );
    }

    return null;
  }

  private incrementFailure(fingerprint: string): number {
    const count = (this.repeatedFailures.get(fingerprint) ?? 0) + 1;
    this.repeatedFailures.set(fingerprint, count);
    return count;
  }
}

export function captureWorkspaceProgress(worktreePath: string): string | null {
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--no-ext-diff", "--binary", "HEAD"],
    { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 8_000_000 }
  );
  if (result.status !== 0) return null;
  const untracked = spawnSync(
    "git",
    ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"],
    { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000 }
  );
  if (untracked.status !== 0) return null;
  const hash = crypto.createHash("sha256");
  hash.update(result.stdout || "");
  hash.update("\0");
  const untrackedFiles = (untracked.stdout || "")
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .sort();
  let hashedBytes = 0;
  for (const relativePath of untrackedFiles) {
    hash.update(relativePath);
    hash.update("\0");
    const absolutePath = path.resolve(worktreePath, relativePath);
    const relativeToWorktree = path.relative(path.resolve(worktreePath), absolutePath);
    if (relativeToWorktree.startsWith("..") || path.isAbsolute(relativeToWorktree)) continue;
    try {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile()) continue;
      if (hashedBytes + stat.size <= MAX_UNTRACKED_HASH_BYTES) {
        hash.update(fs.readFileSync(absolutePath));
        hashedBytes += stat.size;
      } else {
        hash.update(`${stat.size}:${stat.mtimeMs}`);
      }
    } catch {
      hash.update("unreadable");
    }
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function failureFingerprint(phase: GoalPhase, summary: string, error: string | null): string {
  const normalized = redactSensitiveText(`${phase}|${summary}|${error ?? ""}`)
    .toLowerCase()
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function decision(reason: GoalCircuitBreakerReason, summary: string): GoalCircuitBreakerDecision {
  return { reason, summary: truncateForDisplay(redactSensitiveText(summary), SUMMARY_MAX_LENGTH) };
}
