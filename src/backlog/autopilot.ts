import { GoalRunRecord, MaestroDatabase, TaskRecord } from "../db.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { ApplicationCommandError } from "../commands/errors.js";
import { evaluateFeatureTaskReadiness } from "../features/task-scheduler.js";

export type BacklogAutopilotState = "disabled" | "idle" | "working" | "waiting_provider" | "at_capacity";

export type BacklogAutopilotSnapshot = {
  enabled: boolean;
  state: BacklogAutopilotState;
  maxConcurrentGoals: number;
  pollIntervalMs: number;
  runningGoals: number;
  waitingProviderGoals: number;
  queuedTasks: number;
  lastAction: string;
  lastTickAt: string | null;
};

export type BacklogAutopilotOptions = {
  enabled: boolean;
  worktreesRoot: string;
  pollIntervalMs?: number;
  maxConcurrentGoals?: number;
};

export type GoalStarter = {
  start(taskId: number, maxSteps?: number): GoalRunRecord;
};

export type TaskPreparer = (
  database: MaestroDatabase,
  taskId: number,
  worktreesRoot: string
) => TaskPreparationResult;

export type TaskBlockedNotifier = (
  task: TaskRecord,
  reason: string,
  details: string[]
) => Promise<void> | void;

export type TaskPreparationResult =
  | { ok: true; task: TaskRecord; branchName: string; worktreePath: string }
  | { ok: false; errors: string[] };

const SUCCESSFUL_TASK_STATES = new Set(["awaiting_human", "ready_to_merge", "done"]);

export class BacklogAutopilot {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private lastAction = "not_started";
  private lastTickAt: string | null = null;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly goals: GoalStarter,
    private readonly options: BacklogAutopilotOptions,
    private readonly taskPreparer: TaskPreparer = prepareTaskWithCommands,
    private readonly taskBlockedNotifier?: TaskBlockedNotifier
  ) {}

  start(): void {
    if (!this.options.enabled || this.timer) return;
    void this.runScheduledTick();
    this.timer = setInterval(() => void this.runScheduledTick(), this.pollIntervalMs);
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<BacklogAutopilotSnapshot> {
    if (!this.options.enabled) {
      this.lastAction = "disabled";
      return this.snapshot();
    }
    if (this.tickRunning) return this.snapshot();
    this.tickRunning = true;
    this.lastTickAt = new Date().toISOString();

    try {
      const goals = this.database.listActiveGoalRuns();
      const runningGoals = goals.filter((goal) => goal.status === "running");
      if (runningGoals.length >= this.maxConcurrentGoals) {
        this.lastAction = "running_capacity_reached";
        return this.snapshot();
      }

      const tasks = this.database.listTasks(500);
      const activeTasks = goals
        .filter((goal) => goal.status === "running" || goal.status === "waiting_provider")
        .map((goal) => this.database.getTask(goal.taskId));
      const queued = tasks
        .filter((task) => task.status === "queued" || task.status === "waiting_dependency")
        .sort((left, right) => left.id - right.id);

      for (const task of queued) {
        const revalidation = revalidateQueuedTask(task, tasks);
        if (!revalidation.applicable) {
          await this.blockTask(task, revalidation.reason);
          continue;
        }
        const readiness = evaluateFeatureTaskReadiness(this.database, task, activeTasks);
        if (readiness.state === "blocked") {
          await this.blockTask(task, readiness.reason);
          continue;
        }
        if (readiness.state === "waiting") {
          this.waitForDependency(task, readiness.reason);
          continue;
        }
        if (task.status === "waiting_dependency") {
          this.database.updateTaskStatus(task.id, "queued");
          this.database.addEvent({
            source: "maestro",
            type: "backlog.task_dependency_ready",
            text: `Dependencies are ready for task #${task.id}.`,
            taskId: task.id,
            metadata: { featurePlanId: readiness.featurePlan?.plan.id ?? null }
          });
        }
        if (this.database.getTask(task.id).status !== "queued") continue;

        let prepared: TaskPreparationResult;
        try {
          prepared = this.taskPreparer(this.database, task.id, this.options.worktreesRoot);
        } catch {
          prepared = { ok: false, errors: ["task preparation threw"] };
        }
        if (!prepared.ok) {
          if (this.database.getTask(task.id).status !== "queued") continue;
          await this.blockTask(task, "preparation_failed", prepared.errors);
          continue;
        }
        let run: GoalRunRecord;
        try {
          run = this.goals.start(task.id);
        } catch {
          await this.blockTask(this.database.getTask(task.id), "goal_start_failed");
          continue;
        }
        this.database.addEvent({
          source: "maestro",
          type: "backlog.task_started",
          text: `Autopilot started task #${task.id}.`,
          taskId: task.id,
          metadata: { runId: run.id, projectKey: task.projectKey }
        });
        this.lastAction = `started_task_${task.id}`;
        return this.snapshot();
      }

      this.lastAction = queued.length === 0 ? "queue_empty" : "no_independent_task_available";
      return this.snapshot();
    } finally {
      this.tickRunning = false;
    }
  }

  snapshot(): BacklogAutopilotSnapshot {
    const goals = this.database.listActiveGoalRuns();
    const tasks = this.database.listTasks(500);
    const runningGoals = goals.filter((goal) => goal.status === "running").length;
    const waitingProviderGoals = goals.filter((goal) => goal.status === "waiting_provider").length;
    return {
      enabled: this.options.enabled,
      state: !this.options.enabled
        ? "disabled"
        : runningGoals >= this.maxConcurrentGoals
          ? "at_capacity"
          : runningGoals > 0
            ? "working"
            : waitingProviderGoals > 0
              ? "waiting_provider"
              : "idle",
      maxConcurrentGoals: this.maxConcurrentGoals,
      pollIntervalMs: this.pollIntervalMs,
      runningGoals,
      waitingProviderGoals,
      queuedTasks: tasks.filter((task) => task.status === "queued" || task.status === "waiting_dependency").length,
      lastAction: this.lastAction,
      lastTickAt: this.lastTickAt
    };
  }

  private async blockTask(task: TaskRecord, reason: string, details: string[] = []): Promise<void> {
    this.database.updateTaskStatus(task.id, "blocked");
    this.database.addEvent({
      source: "maestro",
      type: "backlog.task_blocked",
      text: `Autopilot blocked task #${task.id} for human review.`,
      taskId: task.id,
      metadata: { reason, details, projectKey: task.projectKey }
    });
    if (this.taskBlockedNotifier) {
      try {
        await this.taskBlockedNotifier(task, reason, details);
      } catch (error) {
        this.database.addEvent({
          source: "telegram",
          type: "backlog.blocked_notification_failed",
          text: `Failed to notify blocked task #${task.id}.`,
          taskId: task.id,
          metadata: { reason, error: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    this.lastAction = `blocked_task_${task.id}_${reason}`;
  }

  private waitForDependency(task: TaskRecord, reason: string): void {
    if (task.status !== "waiting_dependency" && reason.startsWith("dependency_task_")) {
      this.database.updateTaskStatus(task.id, "waiting_dependency");
      this.database.addEvent({
        source: "maestro",
        type: "backlog.task_waiting_dependency",
        text: `Task #${task.id} is waiting for a Feature dependency.`,
        taskId: task.id,
        metadata: { reason, projectKey: task.projectKey }
      });
    }
    this.lastAction = `waiting_task_${task.id}_${reason}`;
  }

  private async runScheduledTick(): Promise<void> {
    try {
      await this.tick();
    } catch {
      this.lastAction = "tick_failed";
      this.database.addEvent({
        source: "maestro",
        type: "backlog.tick_failed",
        text: "Backlog autopilot tick failed; retry scheduled.",
        metadata: {}
      });
    }
  }

  private get pollIntervalMs(): number {
    return Math.max(1_000, this.options.pollIntervalMs ?? 30_000);
  }

  private get maxConcurrentGoals(): number {
    return Math.max(1, this.options.maxConcurrentGoals ?? 1);
  }
}

export function revalidateQueuedTask(
  task: TaskRecord,
  allTasks: TaskRecord[]
): { applicable: true } | { applicable: false; reason: string } {
  if (!task.projectKey) return { applicable: false, reason: "project_missing" };
  const normalizedDemand = normalizeDemand(task.text);
  const duplicate = allTasks.find((candidate) => (
    candidate.id !== task.id
    && candidate.projectKey === task.projectKey
    && SUCCESSFUL_TASK_STATES.has(candidate.status)
    && normalizeDemand(candidate.text) === normalizedDemand
  ));
  return duplicate
    ? { applicable: false, reason: `already_resolved_by_task_${duplicate.id}` }
    : { applicable: true };
}

function normalizeDemand(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function prepareTaskWithCommands(
  database: MaestroDatabase,
  taskId: number,
  worktreesRoot: string
): TaskPreparationResult {
  try {
    const outcome = new ApplicationCommands(database).prepareTask(
      { channel: "maestro" },
      taskId,
      worktreesRoot
    );
    return { ok: true, ...outcome };
  } catch (error) {
    return {
      ok: false,
      errors: error instanceof ApplicationCommandError ? error.details : ["task preparation failed"]
    };
  }
}
