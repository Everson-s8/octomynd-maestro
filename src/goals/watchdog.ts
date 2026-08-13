import { GoalRunRecord, GoalStepRecord, MaestroDatabase } from "../db.js";

/**
 * LoopSignal describes WHY a goal is considered stuck. It is the only thing
 * (besides an actual delivery / acceptance-criteria met) that may terminate a
 * goal — never a raw step count. This is the "kill the budget" watchdog.
 */
export type LoopSignal = "no_progress" | "repeated_failure" | "same_decision";

export interface WatchdogVerdict {
  stop: boolean;
  reason?: LoopSignal;
  stepCount: number;
}

export interface WatchdogDeps {
  /** Hash of the goal worktree contents. Repeat across steps => no forward progress. */
  workspaceHash: (run: GoalRunRecord) => string | null;
  /** Max same-looking recent steps before we call it a loop. */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 2;

/**
 * A stateful, per-run loop detector. Feed it the completed goal steps (oldest
 * first) and the current run; it answers whether the goal is spinning in place.
 *
 * It is intentionally conservative: it only stops on strong evidence of no
 * forward progress, so legitimate long implementations are never killed early.
 */
export class GoalWatchdog {
  private readonly threshold: number;
  constructor(
    private readonly database: MaestroDatabase,
    private readonly deps: WatchdogDeps
  ) {
    this.threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  }

  /** Inspect a run's recent steps and decide if it is looping. */
  verdict(run: GoalRunRecord): WatchdogVerdict {
    const steps = this.recentSteps(run).filter((step) => step.status !== "running");
    if (steps.length < 2) return { stop: false, stepCount: run.stepCount };

    // 1) repeated_failure: the same error text repeated back-to-back.
    const repeatedFailure = this.repeatedFailure(steps);
    if (repeatedFailure) {
      return { stop: true, reason: "repeated_failure", stepCount: run.stepCount };
    }

    // 2) same_decision: in reviewing, the same change-request reason repeated
    //    without new code (no workspace change).
    const sameDecision = this.sameDecision(steps, run);
    if (sameDecision) {
      return { stop: true, reason: "same_decision", stepCount: run.stepCount };
    }

    // 3) no_progress: several consecutive steps with identical summary AND an
    //    unchanged workspace hash => the agent loops without producing diff.
    const noProgress = this.noProgress(steps, run);
    if (noProgress) {
      return { stop: true, reason: "no_progress", stepCount: run.stepCount };
    }

    return { stop: false, stepCount: run.stepCount };
  }

  private recentSteps(run: GoalRunRecord): GoalStepRecord[] {
    return this.database
      .listGoalSteps(run.id)
      .sort((a, b) => a.id - b.id)
      .slice(-Math.max(this.threshold * 2, 4));
  }

  private repeatedFailure(steps: GoalStepRecord[]): boolean {
    const failed = steps.filter((step) => step.status === "failed" || step.status === "blocked");
    if (failed.length < 2) return false;
    const normalized = (text: string | null) => (text ?? "").trim().slice(0, 120);
    let same = 0;
    for (let i = 1; i < failed.length; i++) {
      if (normalized(failed[i].error) === normalized(failed[i - 1].error)) {
        same++;
        if (same >= this.threshold) return true;
      } else {
        same = 0;
      }
    }
    return false;
  }

  private sameDecision(steps: GoalStepRecord[], run: GoalRunRecord): boolean {
    const reviews = steps.filter((step) => step.status === "changes_requested");
    if (reviews.length < 2) return false;
    const hash = this.deps.workspaceHash(run);
    // If the worktree changed since the review, the agent is addressing feedback.
    const workspaceUnchanged = hash == null || steps.slice(0, -1).every(() => hash === hash);
    if (!workspaceUnchanged) return false;
    const normalized = (text: string) => text.trim().slice(0, 120);
    let same = 0;
    for (let i = 1; i < reviews.length; i++) {
      if (normalized(reviews[i].summary) === normalized(reviews[i - 1].summary)) {
        same++;
        if (same >= this.threshold) return true;
      } else {
        same = 0;
      }
    }
    return false;
  }

  private noProgress(steps: GoalStepRecord[], run: GoalRunRecord): boolean {
    const hash = this.deps.workspaceHash(run);
    // Without a workspace hash we fall back to identical summaries.
    if (hash == null) {
      let same = 0;
      for (let i = 1; i < steps.length; i++) {
        if (steps[i].summary.trim() === steps[i - 1].summary.trim()) {
          same++;
          if (same >= this.threshold) return true;
        } else {
          same = 0;
        }
      }
      return false;
    }
    // Count steps since the last workspace change; if too many and summaries are
    // identical, it is spinning.
    let unchangedRuns = 0;
    for (let i = steps.length - 1; i > 0; i--) {
      if (steps[i].summary.trim() === steps[i - 1].summary.trim()) {
        unchangedRuns++;
      } else {
        break;
      }
    }
    return unchangedRuns >= this.threshold;
  }
}
