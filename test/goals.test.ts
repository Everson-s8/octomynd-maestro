import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import {
  AgentCapability,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentProvider,
  AgentProviderId
} from "../src/agents/types.js";
import { createDatabase, GoalRunRecord, MaestroDatabase } from "../src/db.js";
import { GoalCoordinator } from "../src/goals/coordinator.js";
import { runTaskGoal } from "../src/goals/runner.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-goal-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("goal runner", () => {
  it("routes phases and completes a review-adjustment loop without manual status updates", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "boo", name: "Boo", path: projectDir, defaultBranch: "main" });
    const task = database.createTask("add a Telegram integration test", "dashboard", "boo");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-test",
      worktreePath: worktreeDir
    });

    const codex = new FakeProvider("codex", ["planning", "coding", "testing"], () => completed("Codex step"));
    let reviewCount = 0;
    const claude = new FakeProvider("claude", ["reviewing"], () => {
      reviewCount += 1;
      return reviewCount === 1
        ? { ...completed("One concrete issue"), outcome: "changes_requested" }
        : completed("Approved after adjustments");
    });

    const run = await runTaskGoal(
      database,
      new AgentRegistry([codex, claude]),
      task.id,
      { artifactsRoot: path.join(tempDir, "artifacts"), maxSteps: 10 }
    );

    expect(run.status).toBe("completed");
    expect(run.stepCount).toBe(7);
    expect(database.getTask(task.id).status).toBe("done");
    expect(database.listGoalSteps(run.id).map((step) => step.phase)).toEqual([
      "planning",
      "implementing",
      "testing",
      "reviewing",
      "implementing",
      "testing",
      "reviewing"
    ]);
    expect(database.listEvents().some((event) => event.type === "goal.completed")).toBe(true);
  });

  it("falls back to another provider when the preferred provider fails", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "app", path: projectDir });
    const task = database.createTask("finish task", "dashboard", "app");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const codex = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => request.phase === "implementing"
        ? { outcome: "failed", summary: "quota", output: "", error: "quota", durationMs: 1, retryable: true }
        : completed("Codex step")
    );
    const claude = new FakeProvider("claude", ["coding"], () => completed("Claude fallback"));

    const run = await runTaskGoal(
      database,
      new AgentRegistry([codex, claude]),
      task.id,
      { artifactsRoot: path.join(tempDir, "artifacts"), maxSteps: 8 }
    );

    expect(run.status).toBe("completed");
    expect(run.stepCount).toBe(4);
    const implementationProviders = database.listGoalSteps(run.id)
      .filter((step) => step.phase === "implementing")
      .map((step) => step.provider);
    expect(implementationProviders).toEqual(["codex", "claude"]);
  });

  it("delivers an approved goal to a draft pull request and leaves merge as the human gate", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "delivery", path: projectDir });
    const task = database.createTask("ship reviewed changes", "dashboard", "delivery");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-delivery",
      worktreePath: worktreeDir
    });
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      () => completed("approved")
    );

    const run = await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 6,
      delivery: async () => ({
        commitSha: "abc123",
        pullRequestUrl: "https://github.com/example/repo/pull/7",
        branchName: "maestro/task-delivery"
      })
    });

    expect(run.status).toBe("completed");
    expect(run.commitSha).toBe("abc123");
    expect(run.pullRequestUrl).toBe("https://github.com/example/repo/pull/7");
    expect(database.getTask(task.id).status).toBe("awaiting_human");
    expect(database.listEvents().some((event) => event.type === "goal.delivered")).toBe(true);
  });

  it("waits for quota and resumes the same goal automatically", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "resume", path: projectDir });
    const task = database.createTask("resume after quota", "dashboard", "resume");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    let codingAttempts = 0;
    const codex = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => {
        if (request.phase === "implementing" && codingAttempts++ === 0) {
          return { outcome: "failed", summary: "quota", output: "", error: "quota", durationMs: 1, retryable: true };
        }
        return completed("available");
      }
    );
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([codex]),
      path.join(tempDir, "artifacts"),
      20
    );

    const run = coordinator.start(task.id, 8);
    await waitFor(() => database.getGoalRun(run.id).status === "completed");

    expect(database.getTask(task.id).status).toBe("done");
    expect(database.getGoalRun(run.id).stepCount).toBe(4);
    expect(database.listGoalSteps(run.id)).toHaveLength(5);
    expect(database.listEvents().some((event) => event.type === "goal.waiting_provider")).toBe(true);
    expect(database.listEvents().some((event) => event.type === "goal.resumed")).toBe(true);
    coordinator.shutdown();
  });

  it("notifies once when a delivered goal is ready for review", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "boo", path: projectDir });
    const task = database.createTask("ship Telegram test", "dashboard", "boo");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-telegram",
      worktreePath: worktreeDir
    });
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      () => completed("approved")
    );
    const notifications: GoalRunRecord[] = [];
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([provider]),
      path.join(tempDir, "artifacts"),
      20,
      async () => ({
        commitSha: "abc123",
        pullRequestUrl: "https://github.com/example/boo/pull/1",
        branchName: "maestro/task-telegram"
      }),
      async (run) => {
        notifications.push(run);
      }
    );

    const run = coordinator.start(task.id, 6);
    await waitFor(() => notifications.length === 1);

    expect(notifications[0].id).toBe(run.id);
    expect(notifications[0].pullRequestUrl).toBe("https://github.com/example/boo/pull/1");
    coordinator.shutdown();
  });
});

class FakeProvider implements AgentProvider {
  readonly label: string;
  readonly capabilities: ReadonlySet<AgentCapability>;

  constructor(
    readonly id: AgentProviderId,
    capabilities: AgentCapability[],
    private readonly handler: (request: AgentExecutionRequest) => AgentExecutionResult
  ) {
    this.label = id;
    this.capabilities = new Set(capabilities);
  }

  async health() {
    return { state: "ready" as const, detail: "test", checkedAt: new Date().toISOString() };
  }

  async execute(request: AgentExecutionRequest) {
    return this.handler(request);
  }
}

function completed(summary: string): AgentExecutionResult {
  return {
    outcome: "completed",
    summary,
    output: summary,
    error: null,
    durationMs: 1,
    retryable: false
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for goal state.");
}
