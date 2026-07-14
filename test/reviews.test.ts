import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentProvider } from "../src/agents/types.js";
import { createDatabase, GoalRunRecord, MaestroDatabase } from "../src/db.js";
import { MaestroConfig } from "../src/config.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { GoalCoordinator } from "../src/goals/coordinator.js";
import { ReviewCoordinator } from "../src/reviews/coordinator.js";
import { buildReviewQueueItem } from "../src/reviews/evidence.js";
import { PullRequestState, ReviewGitHubGateway } from "../src/reviews/github.js";

let tempDir: string;
let projectDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-review-"));
  projectDir = path.join(tempDir, "project");
  fs.mkdirSync(projectDir);
  git(["init", "-b", "main"]);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Test\n");
  git(["add", "README.md"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  git(["checkout", "-b", "maestro/review-test"]);
  fs.mkdirSync(path.join(projectDir, "src"));
  fs.writeFileSync(path.join(projectDir, "src", "feature.ts"), "export const feature = true;\n");
  git(["add", "src/feature.ts"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Feature"]);

  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: projectDir, defaultBranch: "main" });
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("human review queue", () => {
  it("builds sanitized evidence from goal steps and relative files", () => {
    const run = reviewableGoal();
    const item = buildReviewQueueItem(database, run);

    expect(item.projectKey).toBe("boo");
    expect(item.agents).toEqual(["codex", "claude"]);
    expect(item.changedFiles).toEqual(["src/feature.ts"]);
    expect(item.tests[0].summary).toContain("32 testes");
    expect(item.changeSafetyGate.status).toBe("passed");
    expect(item.securityAlerts[0].code).toBe("secret_scan_passed");
    expect(JSON.stringify(item)).not.toContain(tempDir);
  });

  it("marks a clean diff as passed", () => {
    git(["checkout", "main"]);
    git(["checkout", "-b", "maestro/clean-review"]);
    const run = reviewableGoal({
      branchName: "maestro/clean-review",
      commitSha: git(["rev-parse", "HEAD"]).trim()
    });

    const item = buildReviewQueueItem(database, run);

    expect(item.changedFiles).toEqual([]);
    expect(item.changeSafetyGate.status).toBe("passed");
    expect(item.securityAlerts[0].code).toBe("secret_scan_passed");
  });

  it("fails closed when Git cannot inspect the worktree", async () => {
    const nonRepo = path.join(tempDir, "not-a-repo");
    fs.mkdirSync(nonRepo);
    fs.writeFileSync(path.join(nonRepo, "feature.ts"), "export const feature = true;\n");
    const run = reviewableGoal({
      branchName: "maestro/non-repo-review",
      worktreePath: nonRepo,
      commitSha: "abc123"
    });
    const github = new FakeGitHubGateway();
    const reviews = new ReviewCoordinator(database, idleGoalCoordinator(), github);

    const item = buildReviewQueueItem(database, run);
    expect(item.changedFiles).toEqual([]);
    expect(item.changeSafetyGate.status).toBe("unavailable");
    expect(item.securityAlerts[0]).toMatchObject({
      severity: "warning",
      code: "changed_files_unavailable"
    });

    await expect(reviews.decide(run.id, "approved", "Diff revisado manualmente.")).rejects.toThrow(
      "Change Safety Gate"
    );
    expect(github.actions).toEqual([]);
    expect(database.listHumanReviews(run.id)).toEqual([]);
  });

  it("approves a clean PR without merging it", async () => {
    const run = reviewableGoal();
    const github = new FakeGitHubGateway();
    const reviews = new ReviewCoordinator(database, idleGoalCoordinator(), github);

    const result = await reviews.decide(run.id, "approved", "Testes e diff revisados.");

    expect(github.actions).toEqual(["ready"]);
    expect(database.getTask(run.taskId).status).toBe("ready_to_merge");
    expect(result.review.note).toBe("Testes e diff revisados.");
    expect(database.getLatestHumanReview(run.id)?.decision).toBe("approved");
    expect(github.actions).not.toContain("merge");
  });

  it("rejects and closes the draft PR", async () => {
    const run = reviewableGoal();
    const github = new FakeGitHubGateway();
    const reviews = new ReviewCoordinator(database, idleGoalCoordinator(), github);

    await reviews.decide(run.id, "rejected", "A mudanca nao atende a demanda.");

    expect(github.actions).toEqual(["close"]);
    expect(database.getTask(run.taskId).status).toBe("rejected");
  });

  it("returns a completed goal to implementation with human feedback", async () => {
    const run = reviewableGoal();
    const github = new FakeGitHubGateway();
    let receivedFeedback: string | null | undefined;
    const provider: AgentProvider = {
      id: "codex",
      label: "Codex test",
      capabilities: new Set(["coding"]),
      health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
      execute: async (request) => {
        receivedFeedback = request.humanFeedback;
        return {
          outcome: "blocked",
          summary: "Stopped after feedback capture",
          output: "",
          error: "test stop",
          durationMs: 1,
          retryable: false
        };
      }
    };
    const goals = new GoalCoordinator(database, new AgentRegistry([provider]), path.join(tempDir, "runs"));
    const reviews = new ReviewCoordinator(database, goals, github);

    await reviews.decide(run.id, "changes_requested", "Remova o identificador pessoal do fixture.");
    await waitFor(() => database.getGoalRun(run.id).status === "blocked");

    expect(github.actions).toEqual(["draft"]);
    expect(receivedFeedback).toBe("Remova o identificador pessoal do fixture.");
    expect(database.listGoalSteps(run.id).at(-1)?.phase).toBe("implementing");
    goals.shutdown();
  });

  it("blocks approval when a changed file contains secret-shaped content", async () => {
    fs.writeFileSync(path.join(projectDir, "bad.txt"), `token=${"sk-" + "a".repeat(30)}\n`);
    git(["add", "bad.txt"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Secret-shaped content"]);
    const run = reviewableGoal();
    const github = new FakeGitHubGateway();
    const reviews = new ReviewCoordinator(database, idleGoalCoordinator(), github);

    const item = buildReviewQueueItem(database, run);
    expect(item.changeSafetyGate.status).toBe("blocked");
    expect(item.securityAlerts).toContainEqual(expect.objectContaining({
      severity: "high",
      code: "sensitive_change",
      file: "bad.txt"
    }));
    await expect(reviews.decide(run.id, "approved", "Aprovar mesmo assim.")).rejects.toThrow(
      "Change Safety Gate"
    );
    expect(github.actions).toEqual([]);
    expect(database.listHumanReviews(run.id)).toEqual([]);
  });

  it("rejects decision notes containing secrets before any GitHub action", async () => {
    const run = reviewableGoal();
    const github = new FakeGitHubGateway();
    const reviews = new ReviewCoordinator(database, idleGoalCoordinator(), github);
    const secret = `sk-proj-${"a".repeat(48)}`;

    await expect(reviews.decide(run.id, "approved", `Reviewed with ${secret}`)).rejects.toThrow(
      "secret or private local path"
    );
    expect(github.actions).toEqual([]);
  });

  it("reconciles a pull request merged outside the dashboard", async () => {
    const run = reviewableGoal();
    const github = new FakeGitHubGateway();
    github.state = { isDraft: false, state: "MERGED" };
    const notifications: string[] = [];
    const reviews = new ReviewCoordinator(
      database,
      idleGoalCoordinator(),
      github,
      undefined,
      async (_item, state) => { notifications.push(state); }
    );

    expect(await reviews.reconcile(true)).toBe(1);
    expect(database.getTask(run.taskId).status).toBe("done");
    expect(database.getLastEvent()?.type).toBe("review.sync_merged");
    expect(notifications).toEqual(["MERGED"]);
    expect(reviews.list()).toEqual([]);
  });

  it("continues review reconciliation from background polling", async () => {
    const run = reviewableGoal();
    const github = new FakeGitHubGateway();
    github.state = { isDraft: false, state: "MERGED" };
    const reviews = new ReviewCoordinator(database, idleGoalCoordinator(), github, undefined, undefined, 20);

    reviews.start();
    try {
      await waitFor(() => database.getTask(run.taskId).status === "done");
      expect(database.getLastEvent()?.type).toBe("review.sync_merged");
    } finally {
      reviews.shutdown();
    }
  });

  it("serves the review queue and records an API decision", async () => {
    const run = reviewableGoal();
    const goals = idleGoalCoordinator();
    const github = new FakeGitHubGateway();
    const reviews = new ReviewCoordinator(database, goals, github);
    const config: MaestroConfig = {
      projectName: "review-test",
      databasePath: path.join(tempDir, "maestro.db"),
      worktreesPath: path.join(tempDir, "worktrees"),
      execution: {
        rootPath: tempDir,
        worktreesPath: path.join(tempDir, "worktrees"),
        expectedNodeVersion: "20.17.0",
        supportedNodeRange: ">=20.17.0 <21"
      },
      dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
      autopilot: { enabled: true, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
      runtime: { tokenEfficient: true },
      telegram: { botToken: "not-a-real-token", allowedUserId: "test-user" }
    };
    const server = createDashboardServer({ config, database, staticRoot: tempDir, goalCoordinator: goals, reviewCoordinator: reviews });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const queueResponse = await fetch(`http://127.0.0.1:${port}/api/review-queue`);
      expect(queueResponse.status).toBe(200);
      const queue = await queueResponse.json() as { reviews: Array<{ runId: number }> };
      expect(queue.reviews[0].runId).toBe(run.id);

      const decisionResponse = await fetch(
        `http://127.0.0.1:${port}/api/review-queue/${run.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "approved", note: "API review completed." })
        }
      );
      expect(decisionResponse.status).toBe(200);
      expect(database.getTask(run.taskId).status).toBe("ready_to_merge");
      expect(github.actions).toEqual(["ready"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      goals.shutdown();
    }
  });
});

class FakeGitHubGateway implements ReviewGitHubGateway {
  actions: string[] = [];
  state: PullRequestState = { isDraft: true, state: "OPEN" };
  async inspect() { return this.state; }
  async markReady() { this.actions.push("ready"); }
  async markDraft() { this.actions.push("draft"); }
  async close() { this.actions.push("close"); }
}

function reviewableGoal(options: {
  branchName?: string;
  worktreePath?: string;
  commitSha?: string;
} = {}): GoalRunRecord {
  const task = database.createTask("Criar integracao segura", "dashboard", "boo");
  database.updateTaskWorktree({
    id: task.id,
    status: "planning",
    branchName: options.branchName ?? "maestro/review-test",
    worktreePath: options.worktreePath ?? projectDir
  });
  const run = database.createGoalRun(task.id, 8);
  finishStep(run.id, "planning", "codex", "Plano criado");
  finishStep(run.id, "testing", "codex", "32 testes passaram");
  finishStep(run.id, "reviewing", "claude", "Aprovado sem bloqueios");
  database.updateGoalDelivery({
    id: run.id,
    commitSha: options.commitSha ?? git(["rev-parse", "HEAD"]).trim(),
    pullRequestUrl: "https://github.com/example/boo/pull/1"
  });
  database.updateTaskStatus(task.id, "awaiting_human");
  return database.updateGoalRun({
    id: run.id,
    status: "completed",
    currentPhase: "reviewing",
    stepCount: 3
  });
}

function finishStep(
  runId: number,
  phase: "planning" | "testing" | "reviewing",
  provider: "codex" | "claude",
  summary: string
) {
  const step = database.createGoalStep(runId, phase, provider);
  database.finishGoalStep({ id: step.id, status: "completed", summary, durationMs: 1 });
}

function idleGoalCoordinator() {
  return new GoalCoordinator(database, new AgentRegistry([]), path.join(tempDir, "runs"));
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return result.stdout;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for goal state.");
}
