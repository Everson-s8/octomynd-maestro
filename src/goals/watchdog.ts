import { GoalRunRecord, GoalStepRecord, MaestroDatabase } from "../db.js";

/**
 * LoopSignal describes WHY a goal is considered stuck. It is the only thing
 * (besides an actual delivery / acceptance-criteria met) that may terminate a
 * goal — never a raw step count. This is the loop watchdog.
 */
export type LoopSignal = "no_progress" | "repeated_failure" | "same_decision";

export interface WatchdogVerdict {
  stop: boolean;
  reason?: LoopSignal;
  stepCount: number;
}

export interface WatchdogDeps {
  /** Max same-looking consecutive steps before we call it a loop. */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 2;

/**
 * A per-run loop detector. Feed it the completed goal steps (oldest first) and
 * the current run; it answers whether the goal is spinning in place.
 *
 * It is deliberately CONSERVATIVE: every signal is scoped to consecutive,
 * same-phase steps so a legitimate long implementation (which changes summaries,
 * phases, or fixed errors) is never stopped. We prefer to let a slightly odd
 * goal run over allowing a false positive that kills real work.
 */
export class GoalWatchdog {
  private readonly threshold: number;
  constructor(
    private readonly database: MaestroDatabase,
    private readonly deps: WatchdogDeps = {}
  ) {
    this.threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  }

  /** Inspect a run's recent steps and decide if it is looping. */
  verdict(run: GoalRunRecord): WatchdogVerdict {
    const steps = this.recentSteps(run).filter((step) => step.status !== "running");
    if (steps.length < 2) return { stop: false, stepCount: run.stepCount };
    if (this.repeatedFailure(steps)) {
      return { stop: true, reason: "repeated_failure", stepCount: run.stepCount };
    }
    if (this.sameDecision(steps)) {
      return { stop: true, reason: "same_decision", stepCount: run.stepCount };
    }
    if (this.noProgress(steps)) {
      return { stop: true, reason: "no_progress", stepCount: run.stepCount };
    }
    return { stop: false, stepCount: run.stepCount };
  }

  private recentSteps(run: GoalRunRecord): GoalStepRecord[] {
    return this.database
      .listGoalSteps(run.id)
      .sort((a, b) => a.id - b.id)
      .slice(-Math.max(this.threshold * 3, 6));
  }

  private normalized(text: string | null, length = 200): string {
    // Trim plus collapse internal whitespace so trivial line-ending diffs don't
    // look "different". Generous length reduces prefix collisions between
    // distinct errors/summaries.
    return (text ?? "").replace(/\s+/g, " ").trim().slice(0, length);
  }

  /**
   * The same failure text repeated across consecutive steps in the SAME phase.
   * Scoping to same phase is important: a generic "timeout" failing once in
   * testing then again in an unrelated implementing step is NOT a loop.
   */
  private repeatedFailure(steps: GoalStepRecord[]): boolean {
    const failed = steps.filter((step) => step.status === "failed" || step.status === "blocked");
    if (failed.length < this.threshold) return false;
    let same = 0;
    for (let i = 1; i < failed.length; i++) {
      const samePhase = failed[i].phase === failed[i - 1].phase;
      const sameError = this.normalized(failed[i].error) === this.normalized(failed[i - 1].error);
      if (samePhase && sameError) {
        same++;
        if (same >= this.threshold) return true;
      } else {
        same = 0;
      }
    }
    return false;
  }

  /**
   * In the reviewing phase, the reviewer keeps returning the SAME change-request
   * reason across consecutive steps with NO work in between that changed the
   * code. We require: same phase (reviewing), consecutive, identical normalized
   * summary. Because identical summaries alone are weak evidence, we also require
   * the steps between them did not complete (no new code produced).
   */
  private sameDecision(steps: GoalStepRecord[]): boolean {
    const reviews = steps.filter((step) => step.status === "changes_requested");
    if (reviews.length < this.threshold) return false;
    for (let i = 1; i < reviews.length; i++) {
      const prev = reviews[i - 1];
      const curr = reviews[i];
      const samePhase = prev.phase === curr.phase && prev.phase === "reviewing";
      const sameReason = this.normalized(prev.summary) === this.normalized(curr.summary);
      if (!samePhase || !sameReason) continue;
      // No completed step between the two reviews => the agent produced no new
      // code while re-circling the same feedback.
      const between = steps.filter((s) => s.id > prev.id && s.id < curr.id);
      const noWorkBetween = between.every((s) => s.status === "changes_requested" || s.status === "failed" || s.status === "blocked");
      if (noWorkBetween) return true;
    }
    return false;
  }

  /**
   * True when a step summary is a generic completion placeholder rather than
   * real evidence about what the step did (e.g. "Claude completed the reviewing
   * phase", "6/6 deterministic checks passed"). Such summaries are NOT a signal
   * of no-forward-progress — the same template repeats at every step even when
   * the goal is progressing. The watchdog must not treat placeholder summaries
   * as proof of a loop (a false positive would kill legitimate work).
   */
  /**
   * True when a step summary is EXACTLY a generic completion placeholder rather
   * than real evidence about what the step did (e.g. "Claude completed the
   * reviewing phase", "6/6 deterministic checks passed"). Such templates repeat
   * at every step even when the goal is progressing, so they are NOT a no-
   * progress signal. We anchor on the WHOLE normalized summary so an informative
   * summary that merely mentions "phase" is never misclassified as generic (a
   * false negative would hide a genuine loop).
   */
  private isGenericSummary(summary: string | null): boolean {
    const s = (summary ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!s) return true; // empty summary carries no loop evidence
    // A single terminal '.' (sentence end) is allowed after the phase name.
    // All patterns are anchored on the WHOLE normalized summary so an
    // informative sentence containing "completed the"/"phase" is never
    // misclassified as a generic placeholder (which would hide a real loop).
    return (
      // "<name> completed the <phase> phase." / "<name> completed the <phase>."
      /^[a-z0-9_-]+\s+(completed|concluiu)\s+the\s+\w+(\s+(phase|fase))?\.?\s*$/i.test(s) ||
      // "<name> completed the <phase>."  (no trailing "phase" word, en/pt)
      /^[a-z0-9_-]+\s+(completed|concluiu)\s+the\s+\w+\.\s*$/i.test(s) ||
      // "<name> concluiu a fase <phase>." (the PT template the providers emit)
      /^[a-z0-9_-]+\s+concluiu\s+a\s+fase\s+\w+\.?\s*$/i.test(s) ||
      // "<name> completed the <phase> phase" alt / "<name> concluiu a fase <phase>"
      /^[a-z0-9_-]+\s+(concluiu\s+a\s+fase|completed\s+the)\s+\w+\s*(phase|fase)?\.?\s*$/i.test(s) ||
      /^[\d\s]+\/[\d]+\s+(deterministic\s+)?checks?\s+passed\.?\s*$/i.test(s) ||
      /^\d+\s+checks?\s+passed\.?\s*$/i.test(s) ||
      /^6\/6\s+checks?\s+passed\.?\s*$/i.test(s)
    ) && !/\b(error|failed|stuck|blocked|bug|crash|exception)\b/.test(s);
  }

  /**
   * A run of consecutive identical INFORMATIVE summaries with no completed/failed
   * work that changed the picture. This catches "thinking about the design"
   * forever. Generic completion placeholders are ignored so a goal that is
   * progressing (with templated per-step summaries) is never stopped here.
   */
  private noProgress(steps: GoalStepRecord[]): boolean {
    let same = 0;
    for (let i = 1; i < steps.length; i++) {
      const prevGeneric = this.isGenericSummary(steps[i - 1].summary);
      const currGeneric = this.isGenericSummary(steps[i].summary);
      if (prevGeneric || currGeneric) {
        same = 0; // reset the run — placeholder summaries don't prove a loop
        continue;
      }
      if (steps[i].status === steps[i - 1].status
          && this.normalized(steps[i].summary) === this.normalized(steps[i - 1].summary)) {
        same++;
        if (same >= this.threshold) return true;
      } else {
        same = 0;
      }
    }
    return false;
  }
}
