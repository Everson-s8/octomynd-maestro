import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BacklogAutopilot } from "../src/backlog/autopilot.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { prepareFeatureTaskBaseline } from "../src/features/task-baseline.js";
import {
  featureTaskContractsConflict,
  normalizeFeatureTaskContracts
} from "../src/features/task-graph.js";

let database: MaestroDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-feature-dag-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Feature Task contracts", () => {
  it("defaults legacy plans to a fail-closed serial chain", () => {
    const contracts = normalizeFeatureTaskContracts([1, 2, 3], undefined, (id) => `Implement Task ${id}`);

    expect(contracts.get(1)?.dependsOnTaskIds).toEqual([]);
    expect(contracts.get(2)?.dependsOnTaskIds).toEqual([1]);
    expect(contracts.get(3)?.dependsOnTaskIds).toEqual([2]);
    expect(contracts.get(3)?.mutationScope).toEqual(["**"]);
  });

  it("rejects incomplete explicit contracts and unsafe parallel scope", () => {
    expect(() => normalizeFeatureTaskContracts([1, 2], [{
      taskId: 1,
      acceptanceCriteria: ["done"]
    }], (id) => `Implement Task ${id}`)).toThrow("Missing execution contract");
    expect(() => normalizeFeatureTaskContracts([1], [{
      taskId: 1,
      objective: "Implement a bounded Task",
      acceptanceCriteria: ["done"],
      mutationScope: ["**"],
      parallelMode: "parallel"
    }], () => "task")).toThrow("unrestricted mutation scope");
    expect(() => normalizeFeatureTaskContracts([1], [{
      taskId: 1,
      objective: "Implement a bounded Task",
      acceptanceCriteria: ["done"],
      mutationScope: ["./"],
      parallelMode: "parallel"
    }], () => "task")).toThrow("unrestricted mutation scope");
  });

  it("allows parallel contracts only when mutation scopes do not overlap", () => {
    const [left, right, conflict] = [
      { objective: "left task", acceptanceCriteria: ["done"], excludedScope: [], mutationScope: ["src/a/**"], dependsOnTaskIds: [], parallelMode: "parallel" as const },
      { objective: "right task", acceptanceCriteria: ["done"], excludedScope: [], mutationScope: ["src/b/**"], dependsOnTaskIds: [], parallelMode: "parallel" as const },
      { objective: "conflict task", acceptanceCriteria: ["done"], excludedScope: [], mutationScope: ["src/a/service/**"], dependsOnTaskIds: [], parallelMode: "parallel" as const }
    ];

    expect(featureTaskContractsConflict(left, right)).toBe(false);
    expect(featureTaskContractsConflict(left, conflict)).toBe(true);
    expect(featureTaskContractsConflict(left, {
      ...right,
      mutationScope: ["*.ts"]
    })).toBe(true);
  });
});

describe("Feature Task scheduling", () => {
  it("blocks a dependent Task after its dependency fails", async () => {
    database.registerProject({ key: "maestro", path: tempDir });
    const dependency = database.createTask("Implement dependency", "test", "maestro");
    const dependent = database.createTask("Implement dependent", "test", "maestro");
    database.createFeaturePlan({
      projectKey: "maestro",
      objective: "Deliver dependency-aware execution",
      acceptanceCriteria: ["Dependencies fail closed"],
      taskIds: [dependency.id, dependent.id],
      taskContracts: contractsFor(dependency.id, dependent.id)
    });
    database.updateTaskStatus(dependency.id, "failed");
    const started: number[] = [];

    await autopilot(started).tick();

    expect(started).toEqual([]);
    expect(database.getTask(dependent.id).status).toBe("blocked");
    expect(database.getLastEvent()?.metadata.reason).toBe(`dependency_task_${dependency.id}_failed`);
  });

  it("starts an independent parallel Task in the same project when scopes are disjoint", async () => {
    database.registerProject({ key: "maestro", path: tempDir });
    const left = database.createTask("Implement left module", "test", "maestro");
    const right = database.createTask("Implement right module", "test", "maestro");
    database.createFeaturePlan({
      projectKey: "maestro",
      objective: "Deliver safe parallel execution",
      acceptanceCriteria: ["Scopes remain isolated"],
      taskIds: [left.id, right.id],
      taskContracts: [
        contract(left.id, [], ["src/left/**"]),
        contract(right.id, [], ["src/right/**"])
      ]
    });
    database.updateTaskWorktree({
      id: left.id,
      status: "implementing",
      branchName: "left",
      worktreePath: tempDir
    });
    database.createGoalRun(left.id);
    const started: number[] = [];

    await autopilot(started, 2).tick();

    expect(started).toEqual([right.id]);
  });

  it("blocks a Task when any transitive dependency failed", async () => {
    database.registerProject({ key: "maestro", path: tempDir });
    const foundation = database.createTask("Implement foundation", "test", "maestro");
    const middle = database.createTask("Implement middle layer", "test", "maestro");
    const leaf = database.createTask("Implement leaf layer", "test", "maestro");
    database.createFeaturePlan({
      projectKey: "maestro",
      objective: "Deliver transitive dependency safety",
      acceptanceCriteria: ["Every ancestor must remain valid"],
      taskIds: [foundation.id, middle.id, leaf.id],
      taskContracts: [
        contract(foundation.id, [], ["src/foundation/**"]),
        contract(middle.id, [foundation.id], ["src/middle/**"]),
        contract(leaf.id, [middle.id], ["src/leaf/**"])
      ]
    });
    database.updateTaskStatus(foundation.id, "failed");
    database.updateTaskStatus(middle.id, "awaiting_human");
    const started: number[] = [];

    await autopilot(started).tick();

    expect(started).toEqual([]);
    expect(database.getTask(leaf.id).status).toBe("blocked");
    expect(database.getLastEvent()?.metadata.reason).toBe(`dependency_task_${foundation.id}_failed`);
  });
});

describe("Feature Task baseline", () => {
  it("creates a dependent baseline from exact delivered ancestor commits", () => {
    const projectPath = path.join(tempDir, "project");
    const remotePath = path.join(tempDir, "remote.git");
    const worktreesRoot = path.join(tempDir, "worktrees");
    git(tempDir, "init", "--bare", remotePath);
    fs.mkdirSync(projectPath);
    git(projectPath, "init", "-b", "main");
    git(projectPath, "config", "user.name", "Test");
    git(projectPath, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(projectPath, "README.md"), "base\n");
    git(projectPath, "add", ".");
    git(projectPath, "commit", "-m", "base");
    git(projectPath, "remote", "add", "origin", remotePath);
    git(projectPath, "push", "-u", "origin", "main");
    database.registerProject({ key: "maestro", path: projectPath, defaultBranch: "main" });
    const dependency = database.createTask("Implement dependency module", "test", "maestro");
    const dependent = database.createTask("Implement dependent module", "test", "maestro");
    database.createFeaturePlan({
      projectKey: "maestro",
      objective: "Deliver a resumable dependent baseline",
      acceptanceCriteria: ["Dependent workspace contains ancestor output"],
      taskIds: [dependency.id, dependent.id],
      taskContracts: contractsFor(dependency.id, dependent.id)
    });

    const dependencyWorktree = path.join(worktreesRoot, "maestro", `task-${dependency.id}`);
    git(projectPath, "worktree", "add", "-b", "maestro/dependency", dependencyWorktree, "main");
    fs.writeFileSync(path.join(dependencyWorktree, "dependency.txt"), "validated dependency\n");
    git(dependencyWorktree, "add", ".");
    git(dependencyWorktree, "commit", "-m", `Task #${dependency.id}: dependency`);
    git(dependencyWorktree, "push", "-u", "origin", "maestro/dependency");
    const dependencySha = git(dependencyWorktree, "rev-parse", "HEAD").trim();
    database.updateTaskWorktree({
      id: dependency.id,
      status: "awaiting_human",
      branchName: "maestro/dependency",
      worktreePath: dependencyWorktree,
      baseBranch: "main"
    });
    const run = database.createGoalRun(dependency.id);
    database.updateGoalDelivery({ id: run.id, commitSha: dependencySha, pullRequestUrl: "https://example.test/pr/1" });
    database.updateGoalRun({ id: run.id, status: "completed", currentPhase: "reviewing", stepCount: 4 });

    const baseline = prepareFeatureTaskBaseline(
      database,
      dependent,
      database.getProjectByKey("maestro"),
      worktreesRoot
    );

    expect(baseline.dependencyTaskIds).toEqual([dependency.id]);
    expect(baseline.baseBranch).toContain(`task-${dependent.id}-base`);
    expect(git(projectPath, "show", `${baseline.baseRef}:dependency.txt`)).toContain("validated dependency");
    expect(git(projectPath, "log", "--format=%B", baseline.baseRef).toLowerCase()).toContain(dependencySha);
  }, 20_000);
});

function contractsFor(dependencyId: number, dependentId: number) {
  return [
    contract(dependencyId, [], ["src/dependency/**"]),
    contract(dependentId, [dependencyId], ["src/dependent/**"])
  ];
}

function contract(taskId: number, dependsOnTaskIds: number[], mutationScope: string[]) {
  return {
    taskId,
    objective: `Implement bounded Task ${taskId}`,
    acceptanceCriteria: [`Task #${taskId} is tested`],
    excludedScope: ["unrelated modules"],
    mutationScope,
    dependsOnTaskIds,
    parallelMode: "parallel" as const
  };
}

function autopilot(started: number[], maxConcurrentGoals = 1) {
  return new BacklogAutopilot(
    database,
    {
      start(taskId) {
        started.push(taskId);
        return database.createGoalRun(taskId);
      }
    },
    { enabled: true, worktreesRoot: tempDir, maxConcurrentGoals },
    (store, taskId) => {
      const task = store.updateTaskWorktree({
        id: taskId,
        status: "planning",
        branchName: `task-${taskId}`,
        worktreePath: path.join(tempDir, `task-${taskId}`)
      });
      return { ok: true, task, branchName: task.branchName!, worktreePath: task.worktreePath! };
    }
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
