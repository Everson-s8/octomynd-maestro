import fs from "node:fs";
import { AgentRegistry } from "../agents/registry.js";
import { GoalRunRecord, MaestroDatabase, TaskStatus } from "../db.js";
import { runTaskGoal } from "./runner.js";
import type { GoalRunnerOptions } from "./runner.js";
import { computeTaskDNAFromText, type TaskDNA } from "./task-dna.js";
import { GoalDeliveryHandler } from "./delivery.js";
import { GoalNotificationHandler, GoalProgressNotificationHandler } from "../telegram/notifications.js";
import { Scheduler, SystemScheduler } from "./scheduler.js";
import { EnvironmentBlockedError } from "../environment/doctor.js";
import type { EnvironmentDoctorReport } from "../environment/types.js";
import type { DeterministicValidationRunner } from "../validation/runner.js";
import type { SkillRuntime } from "../skills/runtime.js";
import { captureGoalCheckpoint } from "./checkpoint.js";
import { captureWorkspaceProgress } from "./circuit-breaker.js";

const RESTART_RETRY_DELAY_MS = 5_000;
const NON_RESUMABLE_TASK_STATUSES = new Set<TaskStatus>([
  "awaiting_human",
  "ready_to_merge",
  "rejected",
  "blocked",
  "failed",
  "cancelled",
  "done"
]);

export type GoalPreflight = (taskId: number) => EnvironmentDoctorReport;

export class GoalCoordinator {
  private readonly active = new Map<number, { promise: Promise<GoalRunRecord>; controller: AbortController }>();
  private readonly retryTimers = new Map<number, unknown>();

  constructor(
    private readonly database: MaestroDatabase,
    private readonly registry: AgentRegistry,
    private readonly artifactsRoot: string,
    private readonly retryDelayMs = 15 * 60_000,
    private readonly delivery?: GoalDeliveryHandler,
    private readonly notify?: GoalNotificationHandler,
    private readonly notifyProgress?: GoalProgressNotificationHandler,
    private readonly scheduler: Scheduler = new SystemScheduler(),
    private readonly tokenRuntime?: GoalRunnerOptions["tokenRuntime"],
    private readonly preflight?: GoalPreflight,
    private readonly validationRunner?: Pick<DeterministicValidationRunner, "run">,
    private readonly skillRuntime?: Pick<SkillRuntime, "prepareContext">,
    private readonly goalDeadlineMs?: number,
    private readonly workGraphAdoption?: GoalRunnerOptions["workGraphAdoption"],
    private readonly workGraphRunner?: GoalRunnerOptions["workGraphRunner"]
  ) {}

  start(taskId: number, maxSteps = 12): GoalRunRecord {
    if (this.active.has(taskId)) {
      throw new Error(`Task #${taskId} already has a goal running in this process.`);
    }

    const task = this.database.getTask(taskId);
    if (!task.projectKey) throw new Error(`Task #${taskId} has no project.`);
    if (!task.worktreePath) throw new Error(`Task #${taskId} must be prepared before starting a goal.`);

    // ── Compute TaskDNA for maxSteps ──────────────────────
    const taskDNA = computeTaskDNAFromText(task.text);
    const dnaMaxSteps = taskDNA
      ? Object.values(taskDNA.phaseBudgets).reduce((a, b) => a + b, 0) + 5
      : maxSteps;

    const readiness = this.preflight?.(taskId);
    if (readiness?.status === "environment_blocked") {
      this.database.withTransaction(() => {
        this.database.updateTaskStatus(taskId, "blocked");
        this.database.addEvent({
          source: "maestro",
          type: "goal.environment_blocked",
          text: readiness.summary,
          taskId,
          metadata: { report: readiness }
        });
      });
      throw new EnvironmentBlockedError(readiness);
    }
    if (readiness && readiness.status !== "ready") {
      this.database.addEvent({
        source: "maestro",
        type: "goal.provider_preflight_wait",
        text: readiness.summary,
        taskId,
        metadata: { report: readiness }
      });
    }
    const run = this.database.createGoalRun(taskId, dnaMaxSteps);
    this.execute(run);
    return run;
  }

  resume(runId: number): GoalRunRecord {
    const run = this.database.getGoalRun(runId);
    if (run.status !== "waiting_provider") {
      throw new Error(`Goal #${runId} is not waiting for a provider.`);
    }
    if (this.active.has(run.taskId)) return run;
    this.execute(run);
    return run;
  }

  /**
   * Retry the latest budget-blocked goal for a task, preserving the already-prepared
   * worktree so the work is resumed in place instead of starting a fresh planning
   * cycle from zero. This is the API consumers call by task id.
   */
  retryTask(taskId: number): GoalRunRecord {
    const run = this.database.getLatestBlockedGoalRun(taskId);
    if (!run) {
      throw new Error(`Task #${taskId} has no blocked goal to retry.`);
    }
    return this.retryRun(run.id);
  }

  /**
   * Retry a goal that was hard-blocked by the circuit breaker (budget_exhausted /
   * phase_budget_exhausted), preserving the already-prepared worktree so the
   * work is resumed in place instead of starting a fresh planning cycle from zero.
   */
  retryRun(runId: number): GoalRunRecord {
    const run = this.database.getGoalRun(runId);
    if (run.status !== "blocked") {
      throw new Error(`Goal #${runId} is not blocked and cannot be retried.`);
    }
    const blockedByBudget = (run.lastError ?? "").toLowerCase().includes("budget")
      || (run.lastError ?? "").toLowerCase().includes("without measurable progress")
      || (run.lastError ?? "").toLowerCase().includes("reached its limit");
    if (!blockedByBudget) {
      throw new Error(`Goal #${runId} is not blocked by budget-exhausted; refusing to auto-retry other failures.`);
    }
    if (this.active.has(run.taskId)) {
      throw new Error(`Task #${run.taskId} already has a goal running in this process.`);
    }
    const reopened = this.database.withTransaction(() => {
      const updated = this.database.updateGoalRun({
        id: runId,
        status: "waiting_provider",
        currentPhase: run.currentPhase,
        stepCount: run.stepCount,
        lastError: null,
        nextRetryAt: null
      });
      this.database.updateTaskStatus(run.taskId, "planning");
      this.database.addEvent({
        source: "human",
        type: "goal.retry_requested",
        text: `Goal #${runId} retried from checkpoint (budget-exhausted); preserved worktree will resume.`,
        taskId: run.taskId,
        metadata: { runId, phase: run.currentPhase, stepCount: run.stepCount }
      });
      return updated;
    });
    this.execute(reopened);
    return reopened;
  }

  requestChanges(runId: number): GoalRunRecord {
    const run = this.database.getGoalRun(runId);
    if (this.active.has(run.taskId)) {
      throw new Error(`Task #${run.taskId} already has a goal running in this process.`);
    }
    const reopened = this.database.withTransaction(() => {
      const run = this.database.reopenGoalRun(runId);
      this.database.updateTaskStatus(run.taskId, "changes_requested");
      this.database.addEvent({
        source: "human",
        type: "goal.changes_requested",
        text: `Goal #${runId} returned to implementation.`,
        taskId: run.taskId,
        metadata: { runId }
      });
      return run;
    });
    this.execute(reopened);
    return reopened;
  }

  recoverWaitingRuns(skipRun: (run: GoalRunRecord) => boolean = () => false): number {
    this.recoverLegacyOutputLimitedRuns(skipRun);
    const interrupted = this.database.listActiveGoalRuns()
      .filter((run) => run.status === "running" && !skipRun(run));
    for (const run of interrupted) this.recoverInterruptedRun(run);
    const waiting = this.database.listActiveGoalRuns()
      .filter((run) => run.status === "waiting_provider" && !skipRun(run));
    for (const run of waiting) this.scheduleRetry(run);
    return waiting.length;
  }

  private recoverLegacyOutputLimitedRuns(skipRun: (run: GoalRunRecord) => boolean): void {
    const recoverable = this.database.listGoalRuns(500).filter((run) => (
      run.status === "blocked"
      && !skipRun(run)
      && run.lastError?.includes("output_limit")
    ));
    for (const run of recoverable) {
      this.database.withTransaction(() => {
        this.database.updateGoalRun({
          id: run.id,
          status: "waiting_provider",
          currentPhase: run.currentPhase,
          stepCount: run.stepCount,
          lastError: "Legacy output-limit block recovered. Partial work will resume automatically.",
          waitReason: "output_limit",
          nextRetryAt: new Date(Date.now() + RESTART_RETRY_DELAY_MS).toISOString(),
          lastProvider: run.lastProvider
        });
        this.database.updateTaskStatus(run.taskId, "waiting_provider");
        this.database.addEvent({
          source: "maestro",
          type: "goal.output_limit_recovered",
          text: `Goal #${run.id} recovered from a legacy output-limit block.`,
          taskId: run.taskId,
          metadata: { runId: run.id, worktreePreserved: true }
        });
      });
    }
  }

  shutdown() {
    for (const timer of this.retryTimers.values()) this.scheduler.cancel(timer);
    this.retryTimers.clear();
    for (const active of this.active.values()) active.controller.abort();
  }

  isActive(taskId: number): boolean {
    return this.active.has(taskId);
  }

  cancel(taskId: number): ReturnType<MaestroDatabase["getTask"]> {
    const task = this.database.getTask(taskId);
    if (["done", "failed", "rejected", "cancelled"].includes(task.status)) {
      throw new Error(`Task #${taskId} is already in a terminal state.`);
    }
    const active = this.active.get(taskId);
    if (active) {
      this.database.withTransaction(() => {
        this.database.updateTaskStatus(taskId, "cancelled");
        this.database.addEvent({
          source: "human",
          type: "task.cancel_requested",
          text: `Cancellation requested for task #${taskId}.`,
          taskId
        });
      });
      active.controller.abort();
      return this.database.getTask(taskId);
    }

    const waitingRun = this.database.listActiveGoalRuns().find(
      (run) => run.taskId === taskId && run.status === "waiting_provider"
    );
    if (waitingRun) {
      const timer = this.retryTimers.get(waitingRun.id);
      if (timer !== undefined) this.scheduler.cancel(timer);
      this.retryTimers.delete(waitingRun.id);
    }
    this.database.withTransaction(() => {
      if (waitingRun) {
        this.database.updateGoalRun({
          id: waitingRun.id,
          status: "cancelled",
          currentPhase: waitingRun.currentPhase,
          stepCount: waitingRun.stepCount,
          lastError: "Cancelled by user."
        });
      }
      this.database.updateTaskStatus(taskId, "cancelled");
      this.database.addEvent({
        source: "human",
        type: "task.cancelled",
        text: `Task #${taskId} cancelled by user.`,
        taskId,
        metadata: { runId: waitingRun?.id ?? null }
      });
    });
    return this.database.getTask(taskId);
  }

  private execute(run: GoalRunRecord) {
    const existingTimer = this.retryTimers.get(run.id);
    if (existingTimer !== undefined) this.scheduler.cancel(existingTimer);
    this.retryTimers.delete(run.id);
    const controller = new AbortController();

    // ── Compute TaskDNA from task text ──────────────────────
    const task = this.database.getTask(run.taskId);
    const taskDNA = computeTaskDNAFromText(task.text);

    const promise = runTaskGoal(this.database, this.registry, run.taskId, {
      artifactsRoot: this.artifactsRoot,
      maxSteps: run.maxSteps,
      existingRun: run,
      taskDNA,
      delivery: this.delivery,
      tokenRuntime: this.tokenRuntime,
      validationRunner: this.validationRunner,
      skillRuntime: this.skillRuntime,
      deadlineMs: this.goalDeadlineMs,
      workGraphAdoption: this.workGraphAdoption,
      workGraphRunner: this.workGraphRunner,
      signal: controller.signal,
      onProgress: (progressRun, providerId) => {
        if (!this.notifyProgress) return;
        void this.notifyProgress(progressRun, providerId).catch((error) => {
          this.database.addEvent({
            source: "maestro",
            type: "goal.progress_notification_failed",
            text: error instanceof Error ? error.message : "Unknown progress notification error.",
            taskId: progressRun.taskId,
            metadata: { runId: progressRun.id, phase: progressRun.currentPhase, providerId }
          });
        });
      }
    });
    this.active.set(run.taskId, { promise, controller });
    void promise.then(
      (result) => {
        this.active.delete(run.taskId);
        if (result.status === "waiting_provider") {
          this.scheduleRetry(result);
        }
        if (this.notify && ["completed", "blocked", "failed", "cancelled", "waiting_provider"].includes(result.status)) {
          void this.notify(result).catch((error) => {
            this.database.addEvent({
              source: "maestro",
              type: "goal.notification_failed",
              text: error instanceof Error ? error.message : "Unknown goal notification error.",
              taskId: result.taskId,
              metadata: { runId: result.id, status: result.status }
            });
          });
        }
      },
      () => this.active.delete(run.taskId)
    );
  }

  private recoverInterruptedRun(run: GoalRunRecord): void {
    const task = this.database.getTask(run.taskId);
    const runningStep = [...this.database.listGoalSteps(run.id)]
      .reverse()
      .find((step) => step.status === "running");
    const interruptionSummary = "Maestro runtime restarted while this provider step was active; partial worktree preserved.";

    if (NON_RESUMABLE_TASK_STATUSES.has(task.status)) {
      this.database.withTransaction(() => {
        if (runningStep) {
          this.database.finishGoalStep({
            id: runningStep.id,
            status: "cancelled",
            summary: interruptionSummary,
            error: "Task reached a non-resumable state before runtime recovery.",
            durationMs: elapsedDurationMs(runningStep.createdAt)
          });
        }
        this.database.updateGoalRun({
          id: run.id,
          status: "cancelled",
          currentPhase: run.currentPhase,
          stepCount: run.stepCount,
          lastError: `Task #${task.id} is ${task.status}; stale Goal was not resumed.`
        });
        this.database.addEvent({
          source: "maestro",
          type: "goal.recovery_skipped",
          text: `Stale Goal #${run.id} was not resumed because task #${task.id} is ${task.status}.`,
          taskId: task.id,
          metadata: { runId: run.id, taskStatus: task.status, worktreePreserved: true }
        });
      });
      return;
    }

    if (!task.worktreePath || !fs.existsSync(task.worktreePath)) {
      this.database.withTransaction(() => {
        if (runningStep) {
          this.database.finishGoalStep({
            id: runningStep.id,
            status: "blocked",
            summary: "Runtime recovery failed closed because the task worktree is unavailable.",
            error: task.worktreePath
              ? `Worktree does not exist: ${task.worktreePath}`
              : "Task has no recorded worktree.",
            durationMs: elapsedDurationMs(runningStep.createdAt)
          });
        }
        this.database.updateTaskStatus(task.id, "blocked");
        this.database.updateGoalRun({
          id: run.id,
          status: "blocked",
          currentPhase: run.currentPhase,
          stepCount: run.stepCount,
          lastError: "Runtime recovery could not find the preserved task worktree."
        });
        this.database.addEvent({
          source: "maestro",
          type: "goal.recovery_blocked",
          text: `Goal #${run.id} requires operator attention because its worktree is unavailable.`,
          taskId: task.id,
          metadata: { runId: run.id, worktreePath: task.worktreePath ?? null }
        });
      });
      return;
    }

    let checkpointId: number | null = null;
    if (runningStep && (runningStep.phase === "implementing" || runningStep.phase === "testing")) {
      const previousCheckpoint = this.database.getLatestGoalCheckpoint(run.id);
      const checkpoint = this.database.createGoalCheckpoint(captureGoalCheckpoint({
        runId: run.id,
        stepId: runningStep.id,
        phase: runningStep.phase,
        provider: runningStep.provider,
        interrupted: true,
        summary: interruptionSummary,
        objective: task.text,
        previousCheckpoint,
        workspacePath: task.worktreePath,
        workspaceFingerprint: captureWorkspaceProgress(task.worktreePath),
        artifactKeys: []
      }));
      checkpointId = checkpoint.id;
    }

    const nextRetryAt = new Date(Date.now() + RESTART_RETRY_DELAY_MS).toISOString();
    this.database.withTransaction(() => {
      if (runningStep) {
        this.database.finishGoalStep({
          id: runningStep.id,
          status: "cancelled",
          summary: interruptionSummary,
          error: "Interrupted by Maestro runtime restart.",
          durationMs: elapsedDurationMs(runningStep.createdAt)
        });
      }
      this.database.updateTaskStatus(task.id, "waiting_provider");
      this.database.updateGoalRun({
        id: run.id,
        status: "waiting_provider",
        currentPhase: run.currentPhase,
        stepCount: run.stepCount,
        lastError: interruptionSummary,
        waitReason: "runtime_restart",
        nextRetryAt,
        lastProvider: runningStep?.provider ?? run.lastProvider ?? null
      });
      this.database.addEvent({
        source: "maestro",
        type: "goal.recovered_after_restart",
        text: `Recovered Goal #${run.id} after runtime restart; preserved work will be resumed.`,
        taskId: task.id,
        metadata: {
          runId: run.id,
          stepId: runningStep?.id ?? null,
          checkpointId,
          provider: runningStep?.provider ?? run.lastProvider ?? null,
          phase: run.currentPhase,
          nextRetryAt,
          worktreePreserved: true
        }
      });
    });
  }

  private scheduleRetry(run: GoalRunRecord) {
    if (this.retryTimers.has(run.id)) return;
    const nextRetryAt = run.nextRetryAt ? Date.parse(run.nextRetryAt) : Number.NaN;
    const delayMs = Number.isFinite(nextRetryAt)
      ? Math.max(0, nextRetryAt - Date.now())
      : this.retryDelayMs;
    const timer = this.scheduler.schedule(() => {
      this.retryTimers.delete(run.id);
      try {
        this.resume(run.id);
      } catch (error) {
        this.database.addEvent({
          source: "maestro",
          type: "goal.resume_failed",
          text: error instanceof Error ? error.message : "Unknown goal resume error.",
          taskId: run.taskId,
          metadata: { runId: run.id }
        });
      }
    }, delayMs);
    this.retryTimers.set(run.id, timer);
  }
}

function elapsedDurationMs(createdAt: string): number {
  const startedAt = Date.parse(createdAt);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
}
