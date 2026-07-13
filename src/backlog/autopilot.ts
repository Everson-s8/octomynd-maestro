import { GoalRunRecord, MaestroDatabase, TaskRecord } from "../db.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { ApplicationCommandError } from "../commands/errors.js";

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
    private readonly taskPreparer: TaskPreparer = prepareTaskWithCommands
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
      const goals = this.database.listGoalRuns(500);
      const runningGoals = goals.filter((goal) => goal.status === "running");
      if (runningGoals.length >= this.maxConcurrentGoals) {
        this.lastAction = "running_capacity_reached";
        return this.snapshot();
      }

      const tasks = this.database.listTasks(500);
      const occupiedProjects = occupiedProjectKeys(this.database, goals);
      const queued = tasks.filter((task) => task.status === "queued").sort((left, right) => left.id - right.id);

      for (const task of queued) {
        const revalidation = revalidateQueuedTask(task, tasks);
        if (!revalidation.applicable) {
          this.blockTask(task, revalidation.reason);
          continue;
        }
        if (occupiedProjects.has(task.projectKey!)) continue;
        if (this.database.getTask(task.id).status !== "queued") continue;

        let prepared: TaskPreparationResult;
        try {
          prepared = this.taskPreparer(this.database, task.id, this.options.worktreesRoot);
        } catch {
          prepared = { ok: false, errors: ["task preparation threw"] };
        }
        if (!prepared.ok) {
          if (this.database.getTask(task.id).status !== "queued") continue;
          this.blockTask(task, "preparation_failed");
          continue;
        }
        let run: GoalRunRecord;
        try {
          run = this.goals.start(task.id);
        } catch {
          this.blockTask(this.database.getTask(task.id), "goal_start_failed");
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
    const goals = this.database.listGoalRuns(500);
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
      queuedTasks: tasks.filter((task) => task.status === "queued").length,
      lastAction: this.lastAction,
      lastTickAt: this.lastTickAt
    };
  }

  private blockTask(task: TaskRecord, reason: string): void {
    this.database.updateTaskStatus(task.id, "blocked");
    this.database.addEvent({
      source: "maestro",
      type: "backlog.task_blocked",
      text: `Autopilot blocked task #${task.id} for human review.`,
      taskId: task.id,
      metadata: { reason, projectKey: task.projectKey }
    });
    this.lastAction = `blocked_task_${task.id}_${reason}`;
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

function occupiedProjectKeys(database: MaestroDatabase, goals: GoalRunRecord[]): Set<string> {
  const occupied = new Set<string>();
  for (const goal of goals) {
    if (goal.status !== "running" && goal.status !== "waiting_provider") continue;
    const projectKey = database.getTask(goal.taskId).projectKey;
    if (projectKey) occupied.add(projectKey);
  }
  return occupied;
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
