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
  | "no_progress";

export type GoalCircuitBreakerDecision = {
  reason: GoalCircuitBreakerReason;
  summary: string;
};

export type GoalCircuitBreakerObservation = {
  phase: GoalPhase;
  result: AgentExecutionResult;
  workspaceBefore: string | null;
  workspaceAfter: string | null;
};

const REPEATED_FAILURE_LIMIT = 2;
const NO_PROGRESS_LIMIT = 2;
const SUMMARY_MAX_LENGTH = 300;
const MAX_UNTRACKED_HASH_BYTES = 8_000_000;

export class GoalCircuitBreaker {
  private readonly repeatedFailures = new Map<string, number>();
  private readonly noProgress = new Map<GoalPhase, number>();

  static fromSteps(steps: GoalStepRecord[]): GoalCircuitBreaker {
    const breaker = new GoalCircuitBreaker();
    for (const step of steps) {
      if (step.status !== "failed") continue;
      breaker.incrementFailure(failureFingerprint(step.phase, step.summary, step.error));
    }
    return breaker;
  }

  observe(observation: GoalCircuitBreakerObservation): GoalCircuitBreakerDecision | null {
    const processReason = observation.result.processRuntime?.breakerReason;
    if (processReason === "deadline") {
      return decision("deadline", "Goal deadline reached during provider execution.");
    }
    if (processReason === "duplicate_output" || processReason === "output_limit") {
      return decision(processReason, `Provider stopped by ${processReason}; partial worktree preserved.`);
    }

    if (observation.result.outcome === "failed") {
      const count = this.incrementFailure(failureFingerprint(
        observation.phase,
        observation.result.summary,
        observation.result.error
      ));
      if (count >= REPEATED_FAILURE_LIMIT) {
        return decision("repeated_failure", "The same provider failure repeated without useful recovery.");
      }
      return null;
    }

    if (
      observation.result.outcome === "completed"
      && (observation.phase === "implementing" || observation.phase === "testing")
      && observation.workspaceBefore !== null
      && observation.workspaceBefore === observation.workspaceAfter
    ) {
      const count = (this.noProgress.get(observation.phase) ?? 0) + 1;
      this.noProgress.set(observation.phase, count);
      if (count >= NO_PROGRESS_LIMIT) {
        return decision("no_progress", `${observation.phase} completed repeatedly without changing the worktree.`);
      }
    } else if (observation.workspaceBefore !== observation.workspaceAfter) {
      this.noProgress.set(observation.phase, 0);
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
