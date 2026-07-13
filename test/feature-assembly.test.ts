import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase, TaskRecord } from "../src/db.js";
import { FeatureAssemblyCoordinator, FeatureAssemblyGitHubGateway } from "../src/features/assembly.js";
import { FeaturePullRequestState } from "../src/features/github.js";
import { FeatureIntegrationBuilder, WorkPullRequestGateway } from "../src/features/integration.js";

let tempDir: string;
let projectDir: string;
let remoteDir: string;
let databasePath: string;
let database: MaestroDatabase;
let workGithub: FakeWorkPullRequestGateway;
let assemblyGithub: FakeAssemblyGateway;

const FEATURE_ASSEMBLY_TEST_TIMEOUT_MS = 20_000;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-feature-assembly-"));
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
  workGithub = new FakeWorkPullRequestGateway();
  assemblyGithub = new FakeAssemblyGateway();
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("FeatureAssemblyCoordinator", () => {
  it("does nothing when a Feature Plan task is not yet ready to merge", async () => {
    const notReady = deliveredTask({
      taskText: "add pending change",
      branchName: "maestro/task-pending",
      filePath: "src/pending.ts",
      content: "export const pending = true;\n",
      prNumber: 20
    });
    database.updateTaskStatus(notReady.task.id, "reviewing");
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Wait until every task is ready before assembling.",
      acceptanceCriteria: ["No assembly happens early"],
      taskIds: [notReady.task.id]
    });

    const coordinator = new FeatureAssemblyCoordinator(
      database,
      path.join(tempDir, "worktrees"),
      workGithub,
      assemblyGithub
    );
    const changes = await coordinator.reconcile();

    expect(changes).toBe(0);
    expect(database.findFeatureByFeaturePlanId(plan.plan.id)).toBeNull();
    expect(assemblyGithub.created).toHaveLength(0);
  }, FEATURE_ASSEMBLY_TEST_TIMEOUT_MS);

  it("assembles a single Draft Feature PR once every task is ready to merge", async () => {
    const first = deliveredTask({
      taskText: "add alpha module",
      branchName: "maestro/task-alpha",
      filePath: "src/alpha.ts",
      content: "export const alpha = true;\n",
      prNumber: 21
    });
    const second = deliveredTask({
      taskText: "add beta module",
      branchName: "maestro/task-beta",
      filePath: "src/beta.ts",
      content: "export const beta = true;\n",
      prNumber: 22
    });
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Assemble alpha and beta into one Feature PR.",
      acceptanceCriteria: ["Both tasks are integrated"],
      taskIds: [first.task.id, second.task.id]
    });

    const coordinator = new FeatureAssemblyCoordinator(
      database,
      path.join(tempDir, "worktrees"),
      workGithub,
      assemblyGithub
    );
    const changes = await coordinator.reconcile();

    expect(changes).toBe(1);
    const feature = database.findFeatureByFeaturePlanId(plan.plan.id);
    expect(feature).not.toBeNull();
    expect(feature!.status).toBe("draft");
    expect(feature!.featurePlanId).toBe(plan.plan.id);
    expect(feature!.pullRequestUrl).toBe(assemblyGithub.created[0]!.url);

    const items = database.listFeatureItems(feature!.id);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.taskId).sort()).toEqual([first.task.id, second.task.id].sort());
    expect(items.every((item) => item.status === "included")).toBe(true);

    const remoteBranches = git(["ls-remote", "--heads", remoteDir, feature!.branchName]);
    expect(remoteBranches).toContain(feature!.branchName);

    expect(assemblyGithub.created).toHaveLength(1);
    const created = assemblyGithub.created[0]!;
    expect(created.baseBranch).toBe("main");
    expect(created.body).toContain("## Objective");
    expect(created.body).toContain(plan.plan.objective);
    expect(created.body).toContain("## Tasks");
    expect(created.body).toContain(`Task #${first.task.id}`);
    expect(created.body).toContain(first.commitSha);
    expect(created.body).toContain(first.pullRequestUrl);
    expect(created.body).toContain(`Task #${second.task.id}`);
    expect(created.body).toContain(second.commitSha);
    expect(created.body).toContain(second.pullRequestUrl);
  }, FEATURE_ASSEMBLY_TEST_TIMEOUT_MS);

  it("is idempotent across repeated reconciliation", async () => {
    const delivered = deliveredTask({
      taskText: "add idempotent change",
      branchName: "maestro/task-idempotent",
      filePath: "src/idempotent.ts",
      content: "export const idempotent = true;\n",
      prNumber: 23
    });
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Never duplicate assembly work across reconciliations.",
      acceptanceCriteria: ["A single Feature PR is created"],
      taskIds: [delivered.task.id]
    });

    const coordinator = new FeatureAssemblyCoordinator(
      database,
      path.join(tempDir, "worktrees"),
      workGithub,
      assemblyGithub
    );
    const first = await coordinator.reconcile();
    const second = await coordinator.reconcile();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(assemblyGithub.created).toHaveLength(1);
    const feature = database.findFeatureByFeaturePlanId(plan.plan.id)!;
    expect(database.listFeatureItems(feature.id)).toHaveLength(1);
  }, FEATURE_ASSEMBLY_TEST_TIMEOUT_MS);

  it("resumes registering Feature items if the process is interrupted right after Feature creation", async () => {
    const delivered = deliveredTask({
      taskText: "add resumable registration",
      branchName: "maestro/task-resumable-assembly",
      filePath: "src/resumable-assembly.ts",
      content: "export const resumableAssembly = true;\n",
      prNumber: 24
    });
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Resume Feature item registration after an interrupted assembly.",
      acceptanceCriteria: ["Feature items are eventually registered"],
      taskIds: [delivered.task.id]
    });

    const worktreesRoot = path.join(tempDir, "worktrees");
    const integrationBuilder = new FeatureIntegrationBuilder(database, worktreesRoot, workGithub);
    const integrationDetails = await integrationBuilder.build(plan.plan.id);
    git(["push", "-u", "origin", integrationDetails.integration.branchName], integrationDetails.integration.worktreePath);
    const feature = database.createFeature({
      projectKey: "boo",
      featurePlanId: plan.plan.id,
      name: "Feature Plan resumable registration",
      objective: plan.plan.objective,
      branchName: integrationDetails.integration.branchName,
      worktreePath: integrationDetails.integration.worktreePath,
      pullRequestUrl: "https://github.com/example/boo/pull/900"
    });
    expect(database.listFeatureItems(feature.id)).toHaveLength(0);

    const resumedCoordinator = new FeatureAssemblyCoordinator(
      database,
      worktreesRoot,
      workGithub,
      assemblyGithub
    );
    const changes = await resumedCoordinator.reconcile();

    expect(changes).toBe(1);
    expect(assemblyGithub.created).toHaveLength(0);
    const items = database.listFeatureItems(feature.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      taskId: delivered.task.id,
      pullRequestUrl: delivered.pullRequestUrl,
      branchName: delivered.branchName,
      status: "included"
    });
  }, FEATURE_ASSEMBLY_TEST_TIMEOUT_MS);
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
  workGithub.states.set(pullRequestUrl, pullRequestState({
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

class FakeAssemblyGateway implements FeatureAssemblyGitHubGateway {
  readonly created: Array<{
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
    url: string;
  }> = [];
  private nextPrNumber = 100;

  async findOpenPullRequestByHead(_worktreePath: string, branchName: string): Promise<string | null> {
    const existing = this.created.find((item) => item.branchName === branchName);
    return existing ? existing.url : null;
  }

  async createDraftPullRequest(input: {
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<string> {
    const url = `https://github.com/example/boo/pull/${this.nextPrNumber++}`;
    this.created.push({ ...input, url });
    return url;
  }
}

function git(args: string[], cwd = projectDir): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git failed");
  }
  return result.stdout.trim();
}
