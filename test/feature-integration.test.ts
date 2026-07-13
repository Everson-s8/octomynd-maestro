import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase, TaskRecord } from "../src/db.js";
import {
  createFeatureIntegrationPlan,
  FeatureIntegrationBuilder,
  WorkPullRequestGateway
} from "../src/features/integration.js";
import { FeaturePullRequestState } from "../src/features/github.js";

let tempDir: string;
let projectDir: string;
let remoteDir: string;
let databasePath: string;
let database: MaestroDatabase;
let github: FakeWorkPullRequestGateway;

const FEATURE_INTEGRATION_TEST_TIMEOUT_MS = 20_000;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-feature-integration-"));
  projectDir = path.join(tempDir, "project");
  remoteDir = path.join(tempDir, "origin.git");
  databasePath = path.join(tempDir, "maestro.db");
  fs.mkdirSync(projectDir);
  git(["init", "--bare", remoteDir], tempDir);
  git(["init", "-b", "main"], projectDir);
  git(["config", "user.name", "Maestro Test"]);
  git(["config", "user.email", "maestro@example.invalid"]);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Test\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Initial"]);
  git(["remote", "add", "origin", remoteDir]);
  git(["push", "-u", "origin", "main"]);

  database = createDatabase(databasePath);
  database.registerProject({ key: "boo", name: "Boo", path: projectDir, defaultBranch: "main" });
  github = new FakeWorkPullRequestGateway();
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("FeatureIntegrationBuilder", () => {
  it("creates a deterministic integration worktree from the updated default branch and integrates plan commits in order", async () => {
    const first = deliveredTask({
      taskText: "add alpha",
      branchName: "maestro/task-alpha",
      filePath: "src/alpha.ts",
      content: "export const alpha = true;\n",
      prNumber: 10
    });
    const second = deliveredTask({
      taskText: "add beta",
      branchName: "maestro/task-beta",
      filePath: "src/beta.ts",
      content: "export const beta = true;\n",
      prNumber: 11
    });
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(projectDir, "base.txt"), "updated default\n");
    git(["add", "base.txt"]);
    git(["commit", "-m", "Update default"]);
    git(["push", "origin", "main"]);
    const updatedBase = git(["rev-parse", "HEAD"]);
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Integrate ready task work into one local feature branch.",
      acceptanceCriteria: ["Both commits are present in plan order"],
      taskIds: [first.task.id, second.task.id]
    });

    const builder = new FeatureIntegrationBuilder(database, path.join(tempDir, "worktrees"), github);
    const result = await builder.build(plan.plan.id);

    expect(result.integration.status).toBe("completed");
    expect(result.integration.baseSha).toBe(updatedBase);
    expect(result.integration.branchName).toBe(`maestro/feature-plan-${plan.plan.id}-r1`);
    expect(fs.existsSync(path.join(result.integration.worktreePath, "src", "alpha.ts"))).toBe(true);
    expect(fs.existsSync(path.join(result.integration.worktreePath, "src", "beta.ts"))).toBe(true);
    expect(git(["log", "--reverse", "--format=%s", `${updatedBase}..HEAD`], result.integration.worktreePath).split(/\r?\n/)).toEqual([
      "add alpha",
      "add beta"
    ]);
    expect(database.listFeatures()).toEqual([]);
  }, FEATURE_INTEGRATION_TEST_TIMEOUT_MS);

  it("resumes after restart without duplicating a commit already cherry-picked before its item checkpoint", async () => {
    const delivered = deliveredTask({
      taskText: "add resumable integration item",
      branchName: "maestro/task-resumable",
      filePath: "src/resumable.ts",
      content: "export const resumable = true;\n",
      prNumber: 12
    });
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Resume a partial integration without duplicating commits.",
      acceptanceCriteria: ["Existing cherry-pick trailer is recognized"],
      taskIds: [delivered.task.id]
    });
    const project = database.getProjectByKey("boo");
    const integrationPlan = createFeatureIntegrationPlan(project, plan.plan, path.join(tempDir, "worktrees"));
    const integration = database.createFeaturePlanIntegration({
      featurePlanId: plan.plan.id,
      projectId: project.id,
      planRevision: plan.plan.revision,
      branchName: integrationPlan.branchName,
      worktreePath: integrationPlan.worktreePath
    });
    database.ensureFeaturePlanIntegrationItem({
      integrationId: integration.id,
      featurePlanId: plan.plan.id,
      taskId: delivered.task.id,
      position: 1,
      commitSha: delivered.commitSha,
      pullRequestUrl: delivered.pullRequestUrl,
      branchName: delivered.branchName
    });
    git(["fetch", "origin", "main"]);
    const baseSha = git(["rev-parse", "FETCH_HEAD"]);
    fs.mkdirSync(path.dirname(integrationPlan.worktreePath), { recursive: true });
    git(["worktree", "add", "-b", integrationPlan.branchName, integrationPlan.worktreePath, baseSha]);
    git(["cherry-pick", "-x", delivered.commitSha], integrationPlan.worktreePath);
    const appliedBeforeRestart = git(["rev-parse", "HEAD"], integrationPlan.worktreePath);
    database.updateFeaturePlanIntegration({
      id: integration.id,
      status: "integrating",
      checkpoint: "worktree_created",
      baseSha,
      headSha: appliedBeforeRestart
    });
    database.close();
    database = createDatabase(databasePath);

    const builder = new FeatureIntegrationBuilder(database, path.join(tempDir, "worktrees"), github);
    const result = await builder.build(plan.plan.id);

    expect(result.integration.status).toBe("completed");
    expect(result.items[0]).toMatchObject({
      status: "integrated",
      appliedCommitSha: appliedBeforeRestart
    });
    expect(git(["log", "--format=%H", `${baseSha}..HEAD`], result.integration.worktreePath).split(/\r?\n/)).toHaveLength(1);
  }, FEATURE_INTEGRATION_TEST_TIMEOUT_MS);

  it("fails closed and aborts the cherry-pick when exact commit integration conflicts", async () => {
    fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n");
    git(["add", "shared.txt"]);
    git(["commit", "-m", "Add shared file"]);
    git(["push", "origin", "main"]);
    const delivered = deliveredTask({
      taskText: "change shared in task",
      branchName: "maestro/task-conflict",
      filePath: "shared.txt",
      content: "task change\n",
      prNumber: 13
    });
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(projectDir, "shared.txt"), "default change\n");
    git(["add", "shared.txt"]);
    git(["commit", "-m", "Conflicting default change"]);
    git(["push", "origin", "main"]);
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Detect integration conflicts without continuing.",
      acceptanceCriteria: ["Conflict stops the integration"],
      taskIds: [delivered.task.id]
    });
    const builder = new FeatureIntegrationBuilder(database, path.join(tempDir, "worktrees"), github);

    await expect(builder.build(plan.plan.id)).rejects.toThrow("Cannot cherry-pick");

    const failed = database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.plan.id);
    expect(failed?.integration.status).toBe("failed");
    expect(failed?.items[0].status).toBe("failed");
    expect(git(["status", "--porcelain"], failed!.integration.worktreePath)).toBe("");
  }, FEATURE_INTEGRATION_TEST_TIMEOUT_MS);

  it("blocks integrated diffs that introduce secret-shaped paths", async () => {
    const delivered = deliveredTask({
      taskText: "add environment file",
      branchName: "maestro/task-secret",
      filePath: ".env.local",
      content: "SAFE_PLACEHOLDER=1\n",
      prNumber: 14
    });
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Run secret scan on integrated changes.",
      acceptanceCriteria: ["Sensitive filenames are rejected"],
      taskIds: [delivered.task.id]
    });
    const builder = new FeatureIntegrationBuilder(database, path.join(tempDir, "worktrees"), github);

    await expect(builder.build(plan.plan.id)).rejects.toThrow("Secret guard blocked");

    const failed = database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.plan.id);
    expect(failed?.integration).toMatchObject({
      status: "failed",
      checkpoint: "failed"
    });
    expect(failed?.integration.lastError).toContain(".env.local");
  }, FEATURE_INTEGRATION_TEST_TIMEOUT_MS);

  it("runs git diff --check before completing the integration", async () => {
    const delivered = deliveredTask({
      taskText: "add trailing whitespace",
      branchName: "maestro/task-whitespace",
      filePath: "src/whitespace.ts",
      content: "export const value = true; \n",
      prNumber: 15
    });
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Reject whitespace errors in the integrated diff.",
      acceptanceCriteria: ["git diff --check must pass"],
      taskIds: [delivered.task.id]
    });
    const builder = new FeatureIntegrationBuilder(database, path.join(tempDir, "worktrees"), github);

    await expect(builder.build(plan.plan.id)).rejects.toThrow("validate integration diff whitespace");

    const failed = database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.plan.id);
    expect(failed?.integration.status).toBe("failed");
    expect(failed?.integration.lastError).toContain("trailing whitespace");
  }, FEATURE_INTEGRATION_TEST_TIMEOUT_MS);

  it("validates Work PR head commit before creating an integration checkpoint", async () => {
    const delivered = deliveredTask({
      taskText: "validate exact pr head",
      branchName: "maestro/task-head-mismatch",
      filePath: "src/head.ts",
      content: "export const head = true;\n",
      prNumber: 16
    });
    github.states.set(delivered.pullRequestUrl, {
      ...github.states.get(delivered.pullRequestUrl)!,
      headSha: "f".repeat(40)
    });
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Reject Work PRs whose head moved after goal delivery.",
      acceptanceCriteria: ["Exact delivered commits are required"],
      taskIds: [delivered.task.id]
    });
    const builder = new FeatureIntegrationBuilder(database, path.join(tempDir, "worktrees"), github);

    await expect(builder.build(plan.plan.id)).rejects.toThrow("does not match delivered commit");

    expect(database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.plan.id)).toBeNull();
  }, FEATURE_INTEGRATION_TEST_TIMEOUT_MS);
});

function deliveredTask(input: {
  taskText: string;
  branchName: string;
  filePath: string;
  content: string;
  prNumber: number;
}): { task: TaskRecord; commitSha: string; pullRequestUrl: string; branchName: string } {
  git(["checkout", "main"]);
  git(["checkout", "-b", input.branchName]);
  const absolutePath = path.join(projectDir, input.filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, input.content);
  git(["add", input.filePath]);
  git(["commit", "-m", input.taskText]);
  const commitSha = git(["rev-parse", "HEAD"]);
  git(["push", "-u", "origin", input.branchName]);
  git(["checkout", "main"]);

  const task = database.createTask(input.taskText, "dashboard", "boo");
  database.updateTaskWorktree({
    id: task.id,
    status: "reviewing",
    branchName: input.branchName,
    worktreePath: projectDir
  });
  const run = database.createGoalRun(task.id, 8);
  database.updateGoalDelivery({
    id: run.id,
    commitSha,
    pullRequestUrl: `https://github.com/example/boo/pull/${input.prNumber}`
  });
  database.updateGoalRun({
    id: run.id,
    status: "completed",
    currentPhase: "reviewing",
    stepCount: 4
  });
  database.updateTaskStatus(task.id, "ready_to_merge");

  const pullRequestUrl = `https://github.com/example/boo/pull/${input.prNumber}`;
  github.states.set(pullRequestUrl, pullRequestState({
    number: input.prNumber,
    url: pullRequestUrl,
    headRefName: input.branchName,
    headSha: commitSha
  }));
  return { task: database.getTask(task.id), commitSha, pullRequestUrl, branchName: input.branchName };
}

function pullRequestState(overrides: Partial<FeaturePullRequestState>): FeaturePullRequestState {
  return {
    number: 1,
    title: "Work PR",
    url: "https://github.com/example/boo/pull/1",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefName: "maestro/task",
    headRepositoryOwner: "example",
    headRepositoryName: "boo",
    baseRefName: "main",
    headSha: "a".repeat(40),
    checks: [],
    ...overrides
  };
}

class FakeWorkPullRequestGateway implements WorkPullRequestGateway {
  readonly states = new Map<string, FeaturePullRequestState>();

  async inspect(url: string): Promise<FeaturePullRequestState> {
    const state = this.states.get(url);
    if (!state) throw new Error(`Missing fake Work PR state for ${url}`);
    return { ...state, checks: [...state.checks] };
  }
}

function git(args: string[], cwd = projectDir): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git failed");
  }
  return result.stdout.trim();
}
