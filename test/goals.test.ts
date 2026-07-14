import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
import { ManualScheduler } from "../src/goals/scheduler.js";
import { recoverGoalStepRawOutput } from "../src/runtime/artifacts.js";
import type { ValidationReport } from "../src/validation/runner.js";

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
  it("blocks before provider execution when the absolute goal deadline is exhausted", async () => {
    const projectDir = path.join(tempDir, "deadline-project");
    const worktreeDir = path.join(tempDir, "deadline-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "deadline", path: projectDir });
    const task = database.createTask("bounded task", "dashboard", "deadline");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    let calls = 0;
    const provider = new FakeProvider("codex", ["planning"], () => {
      calls += 1;
      return completed("unexpected");
    });

    const run = await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      deadlineMs: -1
    });

    expect(run.status).toBe("blocked");
    expect(calls).toBe(0);
    expect(database.listEvents().find((event) => event.type === "goal.circuit_breaker")?.metadata.reason)
      .toBe("deadline");
  });

  it("stops repeated provider failures instead of spending another fallback cycle", async () => {
    const projectDir = path.join(tempDir, "failure-project");
    const worktreeDir = path.join(tempDir, "failure-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "failure", path: projectDir });
    const task = database.createTask("failing task", "dashboard", "failure");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const failure = () => ({
      outcome: "failed" as const,
      summary: "same provider timeout 123",
      output: "",
      error: "same provider timeout 456",
      durationMs: 1,
      retryable: true
    });
    const codex = new FakeProvider("codex", ["planning"], failure);
    const claude = new FakeProvider("claude", ["planning"], failure);

    const run = await runTaskGoal(database, new AgentRegistry([codex, claude]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts")
    });

    expect(run.status).toBe("blocked");
    expect(database.listGoalSteps(run.id)).toHaveLength(2);
    expect(database.listEvents().find((event) => event.type === "goal.circuit_breaker")?.metadata.reason)
      .toBe("repeated_failure");
  });

  it("blocks repeated no-progress implementation while preserving the worktree", async () => {
    const projectDir = path.join(tempDir, "progress-project");
    const worktreeDir = path.join(tempDir, "progress-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "progress", path: projectDir });
    const task = database.createTask("task without progress", "dashboard", "progress");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => request.phase === "reviewing"
        ? { ...completed("review requests retry"), outcome: "changes_requested" }
        : completed("claimed completion without edits")
    );

    const run = await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 10
    });

    expect(run.status).toBe("blocked");
    expect(fs.existsSync(path.join(worktreeDir, "README.md"))).toBe(true);
    expect(database.listEvents().find((event) => event.type === "goal.circuit_breaker")?.metadata)
      .toMatchObject({ reason: "no_progress", worktreePreserved: true });
  }, 15_000);

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

  it("uses deterministic validation before spending a testing provider call", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "validated", path: projectDir, defaultBranch: "main" });
    const task = database.createTask("validate centrally", "dashboard", "validated");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-validated",
      worktreePath: worktreeDir
    });
    let testingProviderCalls = 0;
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => {
        if (request.phase === "testing") testingProviderCalls += 1;
        return completed("provider completed");
      }
    );
    let validationCalls = 0;
    const validationRunner = {
      run: async (): Promise<ValidationReport> => {
        validationCalls += 1;
        return validationReport(validationCalls === 1 ? "failed" : "passed");
      }
    };

    const run = await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 8,
      validationRunner
    });

    expect(run.status).toBe("completed");
    expect(validationCalls).toBe(2);
    expect(testingProviderCalls).toBe(1);
    expect(database.listGoalSteps(run.id).map((step) => `${step.phase}/${step.provider}/${step.status}`)).toEqual([
      "planning/codex/completed",
      "implementing/codex/completed",
      "testing/maestro-validation/failed",
      "testing/codex/completed",
      "testing/maestro-validation/completed",
      "reviewing/codex/completed"
    ]);
    expect(database.listEvents().some((event) => event.type === "goal.validation_failed")).toBe(true);
    expect(database.listEvents().some((event) => event.type === "goal.validation_passed")).toBe(true);
    const validationStep = database.listGoalSteps(run.id).find((step) => step.provider === "maestro-validation");
    expect(recoverGoalStepRawOutput(path.join(tempDir, "artifacts"), validationStep!))
      .toContain("validation-report: artifact:validation/test/report.json");
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
        ? {
          outcome: "failed",
          summary: "quota",
          output: "",
          error: "quota",
          durationMs: 1,
          retryable: true,
          processRuntime: {
            breakerReason: null,
            outputStats: { receivedChars: 5, retainedChars: 5, duplicateChunks: 0, truncatedChars: 0 }
          }
        }
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
    const fallbackEvent = database.listEvents().find((event) => event.type === "goal.provider_fallback");
    expect(fallbackEvent?.metadata).toMatchObject({
      fromProvider: "codex",
      toProvider: "claude",
      retryable: true
    });
    const failedStep = database.listGoalSteps(run.id).find((step) => (
      step.phase === "implementing" && step.provider === "codex"
    ));
    const failedStepEvent = database.listEvents().find((event) => (
      event.type === "goal.step_failed" && event.metadata.stepId === failedStep?.id
    ));
    expect(failedStepEvent?.metadata.processRuntime).toMatchObject({
      outputStats: { receivedChars: 5, retainedChars: 5 }
    });
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
    const scheduler = new ManualScheduler();
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([codex]),
      path.join(tempDir, "artifacts"),
      20,
      undefined,
      undefined,
      undefined,
      scheduler
    );

    const run = coordinator.start(task.id, 8);
    await waitFor(() => database.getGoalRun(run.id).status === "waiting_provider");
    expect(scheduler.pendingCount).toBe(1);
    scheduler.flush();
    await waitFor(() => database.getGoalRun(run.id).status === "completed");

    expect(database.getTask(task.id).status).toBe("done");
    expect(database.getGoalRun(run.id).stepCount).toBe(4);
    expect(database.listGoalSteps(run.id)).toHaveLength(5);
    expect(database.listEvents().some((event) => event.type === "goal.waiting_provider")).toBe(true);
    expect(database.listEvents().some((event) => event.type === "goal.resumed")).toBe(true);
    coordinator.shutdown();
  });

  it("resumes with an alternate provider after a retryable failure", async () => {
    const projectDir = path.join(tempDir, "fallback-project");
    const worktreeDir = path.join(tempDir, "fallback-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "fallback", path: projectDir });
    const task = database.createTask("resume with Claude", "dashboard", "fallback");
    database.updateTaskWorktree({
      id: task.id,
      status: "waiting_quota",
      branchName: "task",
      worktreePath: worktreeDir
    });
    const run = database.createGoalRun(task.id, 8);
    const planning = database.createGoalStep(run.id, "planning", "codex");
    database.finishGoalStep({ id: planning.id, status: "completed", summary: "planned", durationMs: 1 });
    const failedCoding = database.createGoalStep(run.id, "implementing", "codex");
    database.finishGoalStep({
      id: failedCoding.id,
      status: "failed",
      summary: "Codex sem cota disponivel.",
      error: "quota",
      durationMs: 1
    });
    const waitingRun = database.updateGoalRun({
      id: run.id,
      status: "waiting_provider",
      currentPhase: "implementing",
      stepCount: 1,
      lastError: "quota"
    });
    let codexCodingCalls = 0;
    const codex = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => {
        if (request.phase === "implementing") codexCodingCalls += 1;
        return completed("Codex available");
      }
    );
    const claude = new FakeProvider(
      "claude",
      ["planning", "coding", "testing", "reviewing"],
      () => completed("Claude fallback")
    );

    const resumed = await runTaskGoal(
      database,
      new AgentRegistry([codex, claude]),
      task.id,
      { artifactsRoot: path.join(tempDir, "artifacts"), existingRun: waitingRun }
    );

    expect(resumed.status).toBe("completed");
    expect(codexCodingCalls).toBe(0);
    expect(database.listGoalSteps(run.id)
      .filter((step) => step.phase === "implementing")
      .map((step) => step.provider)).toEqual(["codex", "claude"]);
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

  it("stores a short, sanitized lastError instead of a giant raw provider dump", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "boo", path: projectDir });
    const task = database.createTask("investigate telemetry leak", "dashboard", "boo");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const fakeSecret = `sk-ant-${"a".repeat(24)}`;
    const hugeLeakyError = [
      `Stack trace referencing C:\\Users\\evers\\Documents\\worktree\\task-9`,
      `Leaked key: ${fakeSecret}`,
      "y".repeat(5_000)
    ].join("\n");
    const codex = new FakeProvider("codex", ["planning"], () => ({
      outcome: "failed",
      summary: "Codex (planning): erro desconhecido.",
      output: hugeLeakyError,
      error: hugeLeakyError,
      durationMs: 1,
      retryable: false
    }));

    const run = await runTaskGoal(
      database,
      new AgentRegistry([codex]),
      task.id,
      { artifactsRoot: path.join(tempDir, "artifacts"), maxSteps: 4 }
    );

    expect(run.status).toBe("failed");
    expect(run.lastError).toBe("Codex (planning): erro desconhecido.");
    expect(run.lastError!.length).toBeLessThan(300);
    expect(run.lastError).not.toContain(fakeSecret);
    expect(run.lastError).not.toContain("C:\\Users\\evers");

    const step = database.listGoalSteps(run.id).at(-1)!;
    expect(step.error).not.toContain(fakeSecret);
    expect(step.error).not.toContain("C:\\Users\\evers");
    expect(step.error).toContain("[REDACTED_SECRET]");
    expect(step.error).toContain("[REDACTED_LOCAL_PATH]");
    expect(step.error).toContain("y".repeat(5_000));
  });

  it("sends compact previous-step handoffs while preserving sanitized raw artifacts and telemetry", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    const artifactsRoot = path.join(tempDir, "artifacts");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "runtime", path: projectDir });
    const task = database.createTask("measure token runtime", "dashboard", "runtime");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const fakeSecret = `${["sk", "proj"].join("-")}-${"z".repeat(24)}`;
    const rawPlanningOutput = [
      "git diff -- src/runtime/compression.ts",
      "diff --git a/src/runtime/compression.ts b/src/runtime/compression.ts",
      "@@ -1 +1 @@",
      `+const token = "${fakeSecret}";`,
      "npm test",
      "PASS test/runtime.test.ts",
      "x".repeat(6_000)
    ].join("\n");
    let capturedHandoff: AgentExecutionRequest["previousStepHandoff"] | undefined;
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => {
        if (request.phase === "planning") return { ...completed("planned"), output: rawPlanningOutput };
        if (request.phase === "implementing") capturedHandoff = request.previousStepHandoff;
        return completed("done");
      }
    );

    const run = await runTaskGoal(
      database,
      new AgentRegistry([provider]),
      task.id,
      { artifactsRoot, maxSteps: 6 }
    );

    expect(run.status).toBe("completed");
    expect(capturedHandoff).toHaveLength(1);
    expect(capturedHandoff![0].compactOutput.length).toBeLessThan(rawPlanningOutput.length);
    expect(capturedHandoff![0].compactOutput).toContain("[REDACTED_SECRET]");
    expect(capturedHandoff![0].compactOutput).not.toContain(fakeSecret);

    const planningStep = database.listGoalSteps(run.id)[0];
    const recovered = recoverGoalStepRawOutput(artifactsRoot, planningStep);
    expect(recovered).toContain("[REDACTED_SECRET]");
    expect(recovered).toContain("x".repeat(6_000));
    expect(recovered).not.toContain(fakeSecret);

    const stepEvent = database.listEvents(100).find((event) => (
      event.type === "goal.step_completed" && event.metadata.stepId === planningStep.id
    ));
    expect(stepEvent?.metadata.tokenRuntime).toMatchObject({
      provider: "codex",
      phase: "planning",
      adapter: "internal",
      artifacts: {
        rawOutputKey: expect.stringContaining("provider-output.raw.txt")
      }
    });
    const tokenRuntime = stepEvent!.metadata.tokenRuntime as {
      baseline: { bytes: number };
      compact: { bytes: number };
      abTest: { savedTokens: number };
    };
    expect(tokenRuntime.baseline.bytes).toBeGreaterThan(tokenRuntime.compact.bytes);
    expect(tokenRuntime.abTest.savedTokens).toBeGreaterThan(0);
  });

  it("cancels an active provider process and preserves task history", async () => {
    const projectDir = path.join(tempDir, "cancel-project");
    const worktreeDir = path.join(tempDir, "cancel-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "cancel", path: projectDir });
    const task = database.createTask("long running task", "dashboard", "cancel");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const provider: AgentProvider = {
      id: "codex",
      label: "Cancelable Codex",
      capabilities: new Set(["planning"]),
      health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
      execute: async (request) => new Promise((resolve) => {
        request.signal?.addEventListener("abort", () => resolve({
          outcome: "cancelled",
          summary: "cancelled",
          output: "",
          error: null,
          durationMs: 1,
          retryable: false
        }), { once: true });
      })
    };
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([provider]),
      path.join(tempDir, "artifacts")
    );

    const run = coordinator.start(task.id, 6);
    await waitFor(() => database.listGoalSteps(run.id).length === 1);
    coordinator.cancel(task.id);
    await waitFor(() => database.getGoalRun(run.id).status === "cancelled");

    expect(database.getTask(task.id).status).toBe("cancelled");
    expect(database.listGoalSteps(run.id).at(-1)?.status).toBe("cancelled");
    expect(database.listEvents().some((event) => event.type === "goal.cancelled")).toBe(true);
    coordinator.shutdown();
  });

  it("treats a rejected provider promise during cancellation as a cancelled step, not a stuck run", async () => {
    const projectDir = path.join(tempDir, "reject-cancel-project");
    const worktreeDir = path.join(tempDir, "reject-cancel-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "reject-cancel", path: projectDir });
    const task = database.createTask("long running task", "dashboard", "reject-cancel");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const provider: AgentProvider = {
      id: "codex",
      label: "Rejecting Codex",
      capabilities: new Set(["planning"]),
      health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
      execute: async (request) => new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("Aborted by signal")), { once: true });
      })
    };
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([provider]),
      path.join(tempDir, "artifacts")
    );

    const run = coordinator.start(task.id, 6);
    await waitFor(() => database.listGoalSteps(run.id).length === 1);
    coordinator.cancel(task.id);
    await waitFor(() => database.getGoalRun(run.id).status === "cancelled");

    expect(database.getTask(task.id).status).toBe("cancelled");
    const steps = database.listGoalSteps(run.id);
    expect(steps.at(-1)?.status).toBe("cancelled");
    expect(steps.some((step) => step.status === "running")).toBe(false);
    coordinator.shutdown();
  });

  it("closes the step and fails the run when a provider throws instead of resolving", async () => {
    const projectDir = path.join(tempDir, "throw-project");
    const worktreeDir = path.join(tempDir, "throw-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "throw", path: projectDir });
    const task = database.createTask("task with a broken provider", "dashboard", "throw");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const codex = new FakeProvider("codex", ["planning"], () => {
      throw new Error("provider crashed unexpectedly");
    });

    const run = await runTaskGoal(
      database,
      new AgentRegistry([codex]),
      task.id,
      { artifactsRoot: path.join(tempDir, "artifacts"), maxSteps: 6 }
    );

    expect(run.status).toBe("failed");
    expect(run.lastError).toContain("provider crashed unexpectedly");
    expect(database.getTask(task.id).status).toBe("failed");
    const steps = database.listGoalSteps(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("failed");
    expect(steps[0].error).toContain("provider crashed unexpectedly");
    expect(database.listEvents().some((event) => event.type === "goal.step_failed")).toBe(true);
    expect(database.listEvents().some((event) => event.type === "goal.failed")).toBe(true);
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

function validationReport(status: "passed" | "failed"): ValidationReport {
  const failed = status === "failed";
  return {
    status,
    summary: failed ? "1/1 deterministic checks failed: typecheck_backend." : "1/1 deterministic checks passed.",
    compactFailure: failed ? "typecheck_backend: expected string" : null,
    durationMs: 1,
    checks: [{
      id: "typecheck_backend",
      status,
      durationMs: 1,
      summary: failed ? "expected string" : "passed",
      artifactKey: `validation/test/typecheck_backend.raw.txt`
    }],
    reportArtifactKey: "validation/test/report.json"
  };
}

function initializeRepository(directory: string): void {
  execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "maestro@example.test"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Maestro Test"], { cwd: directory });
  fs.writeFileSync(path.join(directory, "README.md"), "fixture", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: directory });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: directory, stdio: "ignore" });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for goal state.");
}
