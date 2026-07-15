import { AgentRegistry } from "../agents/registry.js";
import { GoalRunRecord, MaestroDatabase } from "../db.js";
import { runTaskGoal } from "./runner.js";
import type { GoalRunnerOptions } from "./runner.js";
import { GoalDeliveryHandler } from "./delivery.js";
import { GoalNotificationHandler, GoalProgressNotificationHandler } from "../telegram/notifications.js";
import { Scheduler, SystemScheduler } from "./scheduler.js";
import { EnvironmentBlockedError } from "../environment/doctor.js";
import type { EnvironmentDoctorReport } from "../environment/types.js";
import type { DeterministicValidationRunner } from "../validation/runner.js";
import type { SkillRuntime } from "../skills/runtime.js";

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
    private readonly skillRuntime?: Pick<SkillRuntime, "prepareContext">
  ) {}

  start(taskId: number, maxSteps = 12): GoalRunRecord {
    if (this.active.has(taskId)) {
      throw new Error(`Task #${taskId} already has a goal running in this process.`);
    }

    const task = this.database.getTask(taskId);
    if (!task.projectKey) throw new Error(`Task #${taskId} has no project.`);
    if (!task.worktreePath) throw new Error(`Task #${taskId} must be prepared before starting a goal.`);
    const readiness = this.preflight?.(taskId);
    if (readiness && readiness.status !== "ready") {
      this.database.withTransaction(() => {
        this.database.updateTaskStatus(taskId, readiness.status === "quota" ? "waiting_quota" : "blocked");
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
    const run = this.database.createGoalRun(taskId, maxSteps);
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

  recoverWaitingRuns(): number {
    const waiting = this.database.listGoalRuns(500).filter((run) => run.status === "waiting_provider");
    for (const run of waiting) this.scheduleRetry(run);
    return waiting.length;
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

    const waitingRun = this.database.listGoalRuns(500).find(
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
    const promise = runTaskGoal(this.database, this.registry, run.taskId, {
      artifactsRoot: this.artifactsRoot,
      maxSteps: run.maxSteps,
      existingRun: run,
      delivery: this.delivery,
      tokenRuntime: this.tokenRuntime,
      validationRunner: this.validationRunner,
      skillRuntime: this.skillRuntime,
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
          return;
        }
        if (this.notify && ["completed", "blocked", "failed", "cancelled"].includes(result.status)) {
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

  private scheduleRetry(run: GoalRunRecord) {
    if (this.retryTimers.has(run.id)) return;
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
    }, this.retryDelayMs);
    this.retryTimers.set(run.id, timer);
  }
}
