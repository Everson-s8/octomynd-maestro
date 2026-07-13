import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BacklogAutopilot, revalidateQueuedTask } from "../src/backlog/autopilot.js";
import { createDatabase, GoalRunRecord, MaestroDatabase } from "../src/db.js";

let database: MaestroDatabase;
let tempDir: string;
let nextRunId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-autopilot-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "alpha", path: tempDir });
  database.registerProject({ key: "beta", path: tempDir });
  nextRunId = 100;
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("backlog autopilot", () => {
  it("prepares and starts the oldest queued task", async () => {
    const first = database.createTask("first", "dashboard", "alpha");
    database.createTask("second", "dashboard", "beta");
    const started: number[] = [];
    const autopilot = createAutopilot(started);

    const snapshot = await autopilot.tick();

    expect(started).toEqual([first.id]);
    expect(database.getTask(first.id).status).toBe("planning");
    expect(snapshot.lastAction).toBe(`started_task_${first.id}`);
    expect(database.getLastEvent()?.type).toBe("backlog.task_started");
  });

  it("does not let a waiting provider block an independent project", async () => {
    const waitingTask = database.createTask("waiting", "dashboard", "alpha");
    database.updateTaskWorktree({ id: waitingTask.id, status: "waiting_quota", branchName: "waiting", worktreePath: tempDir });
    const waitingRun = database.createGoalRun(waitingTask.id);
    database.updateGoalRun({ id: waitingRun.id, status: "waiting_provider", currentPhase: "planning", stepCount: 0 });
    const sameProject = database.createTask("same project", "dashboard", "alpha");
    const independent = database.createTask("independent", "dashboard", "beta");
    const started: number[] = [];

    await createAutopilot(started).tick();

    expect(started).toEqual([independent.id]);
    expect(database.getTask(sameProject.id).status).toBe("queued");
  });

  it("blocks an exact duplicate for human review and starts the next task", async () => {
    const resolved = database.createTask("Improve Telegram status", "dashboard", "alpha");
    database.updateTaskStatus(resolved.id, "done");
    const duplicate = database.createTask("improve telegram status", "dashboard", "alpha");
    const next = database.createTask("new work", "dashboard", "beta");
    const started: number[] = [];

    await createAutopilot(started).tick();

    expect(database.getTask(duplicate.id).status).toBe("blocked");
    expect(started).toEqual([next.id]);
    expect(database.listEvents().some((event) => event.type === "backlog.task_blocked")).toBe(true);
  });

  it("respects the single running goal capacity", async () => {
    const activeTask = database.createTask("active", "dashboard", "alpha");
    database.updateTaskWorktree({ id: activeTask.id, status: "planning", branchName: "active", worktreePath: tempDir });
    database.createGoalRun(activeTask.id);
    database.createTask("queued", "dashboard", "beta");
    const started: number[] = [];

    const snapshot = await createAutopilot(started).tick();

    expect(started).toEqual([]);
    expect(snapshot.state).toBe("at_capacity");
    expect(snapshot.lastAction).toBe("running_capacity_reached");
  });

  it("does not block a task prepared concurrently by another actor", async () => {
    const task = database.createTask("race", "dashboard", "alpha");
    const started: number[] = [];
    const autopilot = new BacklogAutopilot(
      database,
      { start: () => { throw new Error("must not start"); } },
      { enabled: true, worktreesRoot: tempDir },
      (store, taskId) => {
        store.updateTaskWorktree({ id: taskId, status: "planning", branchName: "manual", worktreePath: tempDir });
        return { ok: false, errors: ["already prepared"] };
      }
    );

    await autopilot.tick();

    expect(started).toEqual([]);
    expect(database.getTask(task.id).status).toBe("planning");
    expect(database.listEvents().some((event) => event.type === "backlog.task_blocked")).toBe(false);
  });

  it("detects already resolved work conservatively", () => {
    const resolved = database.createTask("same demand", "dashboard", "alpha");
    database.updateTaskStatus(resolved.id, "awaiting_human");
    const queued = database.createTask("Same demand", "dashboard", "alpha");

    expect(revalidateQueuedTask(queued, database.listTasks(20))).toEqual({
      applicable: false,
      reason: `already_resolved_by_task_${resolved.id}`
    });
  });
});

function createAutopilot(started: number[]) {
  return new BacklogAutopilot(
    database,
    {
      start(taskId): GoalRunRecord {
        started.push(taskId);
        return {
          id: nextRunId++,
          taskId,
          status: "running",
          currentPhase: "planning",
          stepCount: 0,
          maxSteps: 12,
          lastError: null,
          commitSha: null,
          pullRequestUrl: null,
          createdAt: "now",
          updatedAt: "now",
          finishedAt: null
        };
      }
    },
    { enabled: true, worktreesRoot: tempDir, pollIntervalMs: 1_000, maxConcurrentGoals: 1 },
    (store, taskId) => {
      const task = store.getTask(taskId);
      const updated = store.updateTaskWorktree({
        id: task.id,
        status: "planning",
        branchName: `task-${task.id}`,
        worktreePath: path.join(tempDir, `task-${task.id}`)
      });
      return { ok: true, task: updated, branchName: updated.branchName!, worktreePath: updated.worktreePath! };
    }
  );
}
