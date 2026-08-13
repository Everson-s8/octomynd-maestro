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
  /** Retry a hard-blocked goal (budget_exhausted). Optional — the autopilot
   *  only auto-recovers when the starter provides it (real GoalCoordinator does). */
  retry?: (taskId: number) => GoalRunRecord;
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
  /** Per-run auto-retry budget so a stuck-but-not-loop goal is not retried forever. */
  private autoRetryCounts = new Map<number, number>();
  private autoRetryBackoffUntil = new Map<number, number>();

  /** Max times the autopilot auto-retries the same budget-blocked run before
   *  leaving it `blocked` for human review (prevents an infinite retry furnace). */
  private static readonly MAX_AUTO_RETRIES_PER_GOAL = 3;
  /** Backoff between auto-retries of the same run: 60s, then 5m, then 15m. */
  private backoffMs(attempt: number): number {
    return [60_000, 300_000, 900_000][Math.min(attempt, 2)] ?? 900_000;
  }

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
      const latestUpdate = this.database.getLatestRuntimeUpdate();
      if (latestUpdate && (latestUpdate.status === "pending" || latestUpdate.status === "in_progress")) {
        this.lastAction = "update_pending";
        return this.snapshot();
      }

      const goals = this.database.listActiveGoalRuns();
      const runningGoals = goals.filter((goal) => goal.status === "running");
      if (runningGoals.length >= this.maxConcurrentGoals) {
        this.lastAction = "running_capacity_reached";
        return this.snapshot();
      }

      // Auto-recover goals that were hard-blocked by the budget (with preserved
      // work) — the "kill the budget" fix. Only budget-exhausted blocks that are
      // NOT a real loop (the runner now blocks loops separately) are retried.
      await this.recoverBudgetBlockedGoals();

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

  /**
   * Resume goals that were hard-blocked by the step budget but are NOT a real
   * loop (the runner now blocks genuine loops separately). Budgeted work with a
   * preserved worktree is retried in place via GoalStarter.retry (which elevates
   * the ceiling), so a healthy goal finishes instead of sitting `blocked` until
   * a human retries it. Guarded: only a few per tick, only when not at capacity.
   */
  private async recoverBudgetBlockedGoals(): Promise<void> {
    if (!this.goals.retry) return;
    // listGoalRuns includes blocked runs (listActiveGoalRuns excludes them).
    const budgetBlocked = this.database
      .listGoalRuns(100)
      .filter((goal) => goal.status === "blocked")
      .filter((goal) => {
        const err = (goal.lastError ?? "").toLowerCase();
        const reason = (goal.waitReason ?? "").toLowerCase();
        return (
          reason.includes("budget_exhausted") ||
          err.includes("budget") ||
          err.includes("reached its")
        );
      });
    // Small per-tick cap AND a per-run retry budget + backoff so a stuck-but-not-
    // loop goal is not retried forever (retry furnace). A run is lifted at most
    // MAX_AUTO_RETRIES_PER_GOAL times; after that it stays `blocked` for human.
    const now = Date.now();
    const termStarts = new Set(["completed", "failed", "cancelled", "awaiting_human", "ready_to_merge", "done"]);
    // Forget runs that have reached a TERMINAL state (completed / failed /
    // cancelled / awaiting human), so the per-run counter does not leak forever.
    // We deliberately do NOT clear on "transiently not blocked right now" —
    // retryRun flips the run to waiting_provider and stays alive, so a transient
    // non-blocked state must NOT wipe the counter (that would reopen the furnace).
    const alive = new Set(budgetBlocked.map((goal) => goal.id));
    for (const id of this.autoRetryCounts.keys()) {
      if (!alive.has(id)) {
        const current = this.database.getGoalRun(id);
        if (!current || termStarts.has(current.status)) {
          this.autoRetryCounts.delete(id);
          this.autoRetryBackoffUntil.delete(id);
        }
      }
    }
    for (const goal of budgetBlocked.slice(0, 2)) {
      // Respect the per-run backoff.
      const backoffUntil = this.autoRetryBackoffUntil.get(goal.id) ?? 0;
      if (now < backoffUntil) continue;
      // Enforce the per-run retry budget.
      const attempts = this.autoRetryCounts.get(goal.id) ?? 0;
      if (attempts >= BacklogAutopilot.MAX_AUTO_RETRIES_PER_GOAL) continue;

      try {
        const resumed = this.goals.retry(goal.taskId);
        const nextAttempt = attempts + 1;
        this.autoRetryCounts.set(goal.id, nextAttempt);
        this.autoRetryBackoffUntil.set(goal.id, now + this.backoffMs(nextAttempt));
        this.database.addEvent({
          source: "maestro",
          type: "backlog.goal_auto_retried",
          text: `Autopilot auto-retried budget-blocked goal #${goal.id} for task #${goal.taskId} (ceiling elevated, attempt ${nextAttempt}).`,
          taskId: goal.taskId,
          metadata: { runId: resumed.id, previousRun: goal.id, attempt: nextAttempt }
        });
        this.lastAction = `auto_retried_task_${goal.taskId}`;
      } catch {
        // If retry is not possible (e.g. no preserved work), keep counting so we
        // don't hammer it; leave the block for human review.
        this.autoRetryCounts.set(goal.id, (this.autoRetryCounts.get(goal.id) ?? 0) + 1);
      }
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
