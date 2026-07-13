import { AgentRegistry } from "../agents/registry.js";
import { GoalRunRecord, MaestroDatabase } from "../db.js";
import { runTaskGoal } from "./runner.js";
import { GoalDeliveryHandler } from "./delivery.js";
import { GoalNotificationHandler, GoalProgressNotificationHandler } from "../telegram/notifications.js";

export class GoalCoordinator {
  private readonly active = new Map<number, Promise<GoalRunRecord>>();
  private readonly retryTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly database: MaestroDatabase,
    private readonly registry: AgentRegistry,
    private readonly artifactsRoot: string,
    private readonly retryDelayMs = 15 * 60_000,
    private readonly delivery?: GoalDeliveryHandler,
    private readonly notify?: GoalNotificationHandler,
    private readonly notifyProgress?: GoalProgressNotificationHandler
  ) {}

  start(taskId: number, maxSteps = 12): GoalRunRecord {
    if (this.active.has(taskId)) {
      throw new Error(`Task #${taskId} already has a goal running in this process.`);
    }

    const task = this.database.getTask(taskId);
    if (!task.projectKey) throw new Error(`Task #${taskId} has no project.`);
    if (!task.worktreePath) throw new Error(`Task #${taskId} must be prepared before starting a goal.`);
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
    const reopened = this.database.reopenGoalRun(runId);
    this.database.updateTaskStatus(reopened.taskId, "changes_requested");
    this.database.addEvent({
      source: "human",
      type: "goal.changes_requested",
      text: `Goal #${runId} returned to implementation.`,
      taskId: reopened.taskId,
      metadata: { runId }
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
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  isActive(taskId: number): boolean {
    return this.active.has(taskId);
  }

  private execute(run: GoalRunRecord) {
    const existingTimer = this.retryTimers.get(run.id);
    if (existingTimer) clearTimeout(existingTimer);
    this.retryTimers.delete(run.id);
    const promise = runTaskGoal(this.database, this.registry, run.taskId, {
      artifactsRoot: this.artifactsRoot,
      maxSteps: run.maxSteps,
      existingRun: run,
      delivery: this.delivery,
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
    this.active.set(run.taskId, promise);
    void promise.then(
      (result) => {
        this.active.delete(run.taskId);
        if (result.status === "waiting_provider") {
          this.scheduleRetry(result);
          return;
        }
        if (this.notify && ["completed", "blocked", "failed"].includes(result.status)) {
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
    const timer = setTimeout(() => {
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
