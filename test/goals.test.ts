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
import { WorkGraphCoordinator } from "../src/work-graphs/coordinator.js";

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
  it("passes only prepared governed Skill context to the selected provider", async () => {
    const projectDir = path.join(tempDir, "skill-project");
    const worktreeDir = path.join(tempDir, "skill-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "skills", path: projectDir });
    const task = database.createTask("plan with a governed skill", "dashboard", "skills");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    let received: AgentExecutionRequest["skillContext"];
    const provider = new FakeProvider("codex", ["planning"], (request) => {
      received = request.skillContext;
      return completed("planned");
    });
    const skillContext: NonNullable<AgentExecutionRequest["skillContext"]> = {
      available: [{
        qualifiedName: "repository:plan-task",
        description: "Plan one task.",
        versionId: `sha256:${"a".repeat(64)}`,
        scope: "repository",
        risk: "low"
      }],
      loaded: []
    };

    await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 1,
      skillRuntime: { prepareContext: () => skillContext }
    });

    expect(received).toEqual(skillContext);
    const event = database.listEvents().find((item) => item.type === "goal.skill_context_prepared");
    expect(event?.metadata.available).toEqual([{
      qualifiedName: "repository:plan-task",
      versionId: `sha256:${"a".repeat(64)}`,
      risk: "low"
    }]);
  });

  it("records a governed Work Graph adoption decision before routing without fanning out automatically", async () => {
    const projectDir = path.join(tempDir, "work-graph-project");
    const worktreeDir = path.join(tempDir, "work-graph-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "workgraph", path: projectDir });
    const task = database.createTask("plan a small change", "dashboard", "workgraph");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const provider = new FakeProvider("codex", ["planning"], () => completed("planned"));

    const run = await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 1,
      workGraphAdoption: { mode: "shadow" }
    });

    const events = database.listEvents();
    const decisionIndex = events.findIndex((event) => event.type === "goal.work_graph_adoption_decision");
    const stepStartedIndex = events.findIndex((event) => event.type === "goal.step_started");
    expect(decisionIndex).toBeGreaterThanOrEqual(0);
    expect(stepStartedIndex).toBeLessThan(decisionIndex);
    expect(events[decisionIndex].id).toBeLessThan(events[stepStartedIndex].id);
    expect(events[decisionIndex].metadata).toMatchObject({
      mode: "shadow",
      decision: "shadow",
      reason: "shadow_mode_records_only",
      executionMode: "linear",
      automaticFanOut: false
    });
    expect(database.listGoalSteps(run.id)).toHaveLength(1);
  });

  it("defaults Work Graph adoption to off when the runner option is not provided", async () => {
    const projectDir = path.join(tempDir, "work-graph-default-project");
    const worktreeDir = path.join(tempDir, "work-graph-default-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "workgraphdefault", path: projectDir });
    const task = database.createTask("plan a small change", "dashboard", "workgraphdefault");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const provider = new FakeProvider("codex", ["planning"], () => completed("planned"));

    await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 1
    });

    const decision = database.listEvents().find((event) => event.type === "goal.work_graph_adoption_decision");
    expect(decision?.metadata).toMatchObject({
      mode: "off",
      decision: "off",
      reason: "disabled_by_config"
    });
  });

  it("executes an explicit Work Graph inline for implementing and continues to validation, review and delivery", async () => {
    const projectDir = path.join(tempDir, "explicit-graph-project");
    const worktreeDir = path.join(tempDir, "explicit-graph-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "explicitgraph", path: projectDir });
    const task = database.createTask("deliver a bounded change", "dashboard", "explicitgraph");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-explicit",
      worktreePath: worktreeDir
    });
    database.createFeaturePlan({
      projectKey: "explicitgraph",
      objective: "Deliver a bounded change through an explicit Work Graph.",
      acceptanceCriteria: ["The change ships through the deterministic pipeline."],
      taskIds: [task.id],
      taskContracts: [{
        taskId: task.id,
        objective: "Deliver a bounded change through an explicit Work Graph.",
        acceptanceCriteria: ["The change ships through the deterministic pipeline."],
        mutationScope: ["src/feature/**"],
        workGraphRequest: {
          objective: "Implement the bounded change.",
          nodes: [{
            key: "implement",
            role: "implementer",
            capability: "coding",
            objective: "Implement the change.",
            outputContract: "Implementation report.",
            writeScope: ["src/feature/**"]
          }]
        }
      }]
    });
    let directImplementingCalls = 0;
    let workerNodeCalls = 0;
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => {
        if (request.phase === "implementing" && !request.workerContext) directImplementingCalls += 1;
        if (request.workerContext) workerNodeCalls += 1;
        return completed("provider completed");
      }
    );
    const registry = new AgentRegistry([provider]);
    const workGraphCoordinator = new WorkGraphCoordinator(database, registry, path.join(tempDir, "artifacts"));

    const run = await runTaskGoal(database, registry, task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 8,
      workGraphAdoption: { mode: "explicit" },
      workGraphRunner: workGraphCoordinator,
      validationRunner: { run: async () => validationReport("passed") },
      delivery: async () => ({
        commitSha: "abc123",
        pullRequestUrl: "https://github.com/example/repo/pull/9",
        branchName: "maestro/task-explicit"
      })
    });

    expect(run.status).toBe("completed");
    expect(directImplementingCalls).toBe(0);
    expect(workerNodeCalls).toBe(1);
    expect(database.listGoalSteps(run.id).map((step) => `${step.phase}/${step.provider}/${step.status}`)).toEqual([
      "planning/codex/completed",
      "implementing/work-graph/completed",
      "testing/maestro-validation/completed",
      "reviewing/codex/completed"
    ]);
    const graph = database.findWorkGraphByRunId(run.id);
    expect(graph?.status).toBe("completed");
    expect(database.listEvents().some((event) => event.type === "goal.work_graph_created")).toBe(true);
    expect(database.listEvents().find((event) => event.type === "goal.work_graph_adoption_decision")?.metadata)
      .toMatchObject({ decision: "explicit", executionMode: "work_graph", telemetry: { trigger: "task_metadata" } });
    await workGraphCoordinator.shutdown();
  });

  it("resumes a completed explicit Work Graph by creating its handoff without repeating implementation", async () => {
    const projectDir = path.join(tempDir, "completed-graph-project");
    const worktreeDir = path.join(tempDir, "completed-graph-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "completedgraph", path: projectDir });
    const task = database.createTask("resume a completed graph", "dashboard", "completedgraph");
    database.updateTaskWorktree({
      id: task.id,
      status: "implementing",
      branchName: "maestro/task-completed-graph",
      worktreePath: worktreeDir
    });
    database.createFeaturePlan({
      projectKey: "completedgraph",
      objective: "Resume a completed graph without repeating implementation.",
      acceptanceCriteria: ["The graph handoff continues through deterministic delivery."],
      taskIds: [task.id],
      taskContracts: [{
        taskId: task.id,
        objective: "Resume a completed graph without repeating implementation.",
        acceptanceCriteria: ["The graph handoff continues through deterministic delivery."],
        mutationScope: ["src/feature/**"],
        workGraphRequest: {
          objective: "Implement the bounded change once.",
          nodes: [{
            key: "implement",
            role: "implementer",
            capability: "coding",
            objective: "Implement the change.",
            outputContract: "Implementation report.",
            writeScope: ["src/feature/**"]
          }]
        }
      }]
    });
    const existingRun = database.createGoalRun(task.id, 8);
    const planningStep = database.createGoalStep(existingRun.id, "planning", "claude");
    database.finishGoalStep({
      id: planningStep.id,
      status: "completed",
      summary: "Planning completed before restart.",
      durationMs: 1
    });
    database.updateGoalRun({
      id: existingRun.id,
      status: "running",
      currentPhase: "implementing",
      stepCount: 1
    });
    const graph = database.createWorkGraph({
      runId: existingRun.id,
      objective: "Implement the bounded change once.",
      nodes: [{
        key: "implement",
        role: "implementer",
        capability: "coding",
        objective: "Implement the change.",
        outputContract: "Implementation report.",
        mode: "writer",
        writeScope: ["src/feature/**"],
        budget: { maxAttempts: 2, deadlineMs: 300_000, outputChars: 8_000 }
      }]
    });
    database.updateWorkGraphStatus(graph.id, "validated");
    database.updateWorkGraphStatus(graph.id, "running");
    database.updateWorkerNodeStatus(graph.nodes[0]!.id, "ready");
    const completedAttempt = database.createWorkerAttempt(graph.nodes[0]!.id, "codex");
    database.finishWorkerAttempt({
      id: completedAttempt.id,
      status: "completed",
      summary: "Implementation completed before restart.",
      durationMs: 1
    });
    database.updateWorkerNodeStatus(graph.nodes[0]!.id, "completed");
    database.updateWorkGraphStatus(graph.id, "completed");

    let directImplementingCalls = 0;
    const provider = new FakeProvider("codex", ["coding", "reviewing"], (request) => {
      if (request.phase === "implementing" && !request.workerContext) directImplementingCalls += 1;
      return completed("provider completed");
    });
    const registry = new AgentRegistry([provider]);
    const workGraphCoordinator = new WorkGraphCoordinator(database, registry, path.join(tempDir, "artifacts"));

    const result = await runTaskGoal(database, registry, task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      existingRun: database.getGoalRun(existingRun.id),
      workGraphAdoption: { mode: "explicit" },
      workGraphRunner: workGraphCoordinator,
      validationRunner: { run: async () => validationReport("passed") },
      delivery: async () => ({
        commitSha: "resume123",
        pullRequestUrl: "https://github.com/example/repo/pull/11",
        branchName: "maestro/task-completed-graph"
      })
    });

    expect(result.status).toBe("completed");
    expect(directImplementingCalls).toBe(0);
    expect(database.listGoalSteps(result.id).map((step) => `${step.phase}/${step.provider}/${step.status}`)).toEqual([
      "planning/claude/completed",
      "implementing/work-graph/completed",
      "testing/maestro-validation/completed",
      "reviewing/codex/completed"
    ]);
    await workGraphCoordinator.shutdown();
  });

  it("keeps the linear single-agent path when explicit mode has no persisted Work Graph request", async () => {
    const projectDir = path.join(tempDir, "explicit-no-request-project");
    const worktreeDir = path.join(tempDir, "explicit-no-request-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "explicitnorequest", path: projectDir });
    const task = database.createTask("small unplanned change", "dashboard", "explicitnorequest");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      () => completed("provider completed")
    );
    const registry = new AgentRegistry([provider]);
    const workGraphCoordinator = new WorkGraphCoordinator(database, registry, path.join(tempDir, "artifacts"));

    const run = await runTaskGoal(database, registry, task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 8,
      workGraphAdoption: { mode: "explicit", explicitRequest: true },
      workGraphRunner: workGraphCoordinator,
      validationRunner: { run: async () => validationReport("passed") }
    });

    expect(run.status).toBe("completed");
    const implementingStep = database.listGoalSteps(run.id).find((step) => step.phase === "implementing");
    expect(implementingStep?.provider).toBe("codex");
    expect(database.findWorkGraphByRunId(run.id)).toBeNull();
    await workGraphCoordinator.shutdown();
  });

  it("does not execute a Work Graph in shadow mode even when a request is persisted", async () => {
    const projectDir = path.join(tempDir, "shadow-graph-project");
    const worktreeDir = path.join(tempDir, "shadow-graph-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "shadowgraph", path: projectDir });
    const task = database.createTask("deliver a bounded change", "dashboard", "shadowgraph");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-shadow",
      worktreePath: worktreeDir
    });
    database.createFeaturePlan({
      projectKey: "shadowgraph",
      objective: "Deliver a bounded change with a shadowed Work Graph request.",
      acceptanceCriteria: ["The change ships through the deterministic pipeline."],
      taskIds: [task.id],
      taskContracts: [{
        taskId: task.id,
        objective: "Deliver a bounded change with a shadowed Work Graph request.",
        acceptanceCriteria: ["The change ships through the deterministic pipeline."],
        mutationScope: ["src/feature/**"],
        workGraphRequest: {
          objective: "Implement the bounded change.",
          nodes: [{
            key: "implement",
            role: "implementer",
            capability: "coding",
            objective: "Implement the change.",
            outputContract: "Implementation report.",
            writeScope: ["src/feature/**"]
          }]
        }
      }]
    });
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      () => completed("provider completed")
    );
    const registry = new AgentRegistry([provider]);
    const workGraphCoordinator = new WorkGraphCoordinator(database, registry, path.join(tempDir, "artifacts"));

    const run = await runTaskGoal(database, registry, task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 8,
      workGraphAdoption: { mode: "shadow" },
      workGraphRunner: workGraphCoordinator,
      validationRunner: { run: async () => validationReport("passed") },
      delivery: async () => ({
        commitSha: "def456",
        pullRequestUrl: "https://github.com/example/repo/pull/10",
        branchName: "maestro/task-shadow"
      })
    });

    expect(run.status).toBe("completed");
    const implementingStep = database.listGoalSteps(run.id).find((step) => step.phase === "implementing");
    expect(implementingStep?.provider).toBe("codex");
    expect(database.findWorkGraphByRunId(run.id)).toBeNull();
    await workGraphCoordinator.shutdown();
  });

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

  it("pauses output-limited work for automatic resume instead of blocking the task", async () => {
    const projectDir = path.join(tempDir, "output-limit-project");
    const worktreeDir = path.join(tempDir, "output-limit-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "output-limit", path: projectDir });
    const task = database.createTask("verbose provider task", "dashboard", "output-limit");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const provider = new FakeProvider("codex", ["planning"], () => ({
      outcome: "failed",
      summary: "Provider produced too much output.",
      output: "partial output",
      error: "output limit",
      durationMs: 1,
      retryable: true,
      processRuntime: {
        breakerReason: "output_limit",
        outputStats: { receivedChars: 2_000_001, retainedChars: 500_000, duplicateChunks: 0, truncatedChars: 1_500_001 }
      }
    }));

    const run = await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts")
    });

    expect(run.status).toBe("waiting_provider");
    expect(run.waitReason).toBe("output_limit");
    expect(database.getTask(task.id).status).toBe("waiting_provider");
    expect(database.listEvents().find((event) => event.type === "goal.output_limit_checkpoint")?.metadata)
      .toMatchObject({ worktreePreserved: true, provider: "codex" });
    expect(database.listEvents().some((event) => event.type === "goal.circuit_breaker")).toBe(false);
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

  it("pauses repeated no-progress implementation for provider handoff while preserving the worktree", async () => {
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

    expect(run.status).toBe("waiting_provider");
    expect(fs.existsSync(path.join(worktreeDir, "README.md"))).toBe(true);
    expect(database.listEvents().find((event) => event.type === "goal.no_progress_wait")?.metadata)
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
  }, 15_000);

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

  it("waits for an untried provider and resumes it with preserved context", async () => {
    const projectDir = path.join(tempDir, "exhaustion-project");
    const worktreeDir = path.join(tempDir, "exhaustion-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "exhaustion", path: projectDir });
    const task = database.createTask("preserve handoff across providers", "dashboard", "exhaustion");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const failure = (provider: string): AgentExecutionResult => ({
      outcome: "failed",
      summary: `${provider} failed`,
      output: "",
      error: `${provider} unavailable`,
      durationMs: 1,
      retryable: true,
      retryAfterMs: 1_000,
      failureCategory: "capacity"
    });
    const antigravity = new FakeProvider(
      "antigravity",
      ["planning", "coding"],
      (request) => {
        if (request.phase === "planning") return completed("Antigravity plan");
        fs.writeFileSync(path.join(worktreeDir, "partial.ts"), "export const partial = true;\n", "utf8");
        return failure("antigravity");
      }
    );
    const codex = new FakeProvider("codex", ["coding"], () => failure("codex"));
    let claudeHealthChecks = 0;
    const claudeRequests: AgentExecutionRequest[] = [];
    const claude: AgentProvider = {
      id: "claude",
      label: "claude",
      capabilities: new Set(["coding", "testing", "reviewing"]),
      async health() {
        claudeHealthChecks += 1;
        return claudeHealthChecks === 1
          ? { state: "offline", detail: "temporarily busy", checkedAt: new Date().toISOString() }
          : { state: "ready", detail: "ready", checkedAt: new Date().toISOString() };
      },
      async execute(request) {
        claudeRequests.push(request);
        return completed(`Claude ${request.phase}`);
      }
    };
    const registry = new AgentRegistry([antigravity, codex, claude]);

    const waiting = await runTaskGoal(database, registry, task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 8
    });

    expect(waiting.status).toBe("waiting_provider");
    expect(database.listGoalSteps(waiting.id)
      .filter((step) => step.phase === "implementing")
      .map((step) => step.provider)).toEqual(["antigravity", "codex"]);
    expect(database.listEvents().some((event) => event.type === "goal.circuit_breaker")).toBe(false);

    const resumed = await runTaskGoal(database, registry, task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      existingRun: waiting,
      maxSteps: 8
    });

    expect(resumed.status).toBe("completed");
    expect(database.listGoalSteps(resumed.id)
      .filter((step) => step.phase === "implementing")
      .map((step) => step.provider)).toEqual(["antigravity", "codex", "claude"]);
    const resumedRequest = claudeRequests.find((request) => request.phase === "implementing");
    expect(resumedRequest?.previousSteps.map((step) => step.provider)).toEqual([
      "antigravity",
      "antigravity",
      "codex"
    ]);
    expect(resumedRequest?.resumeContext).toContain("partial.ts");
    expect(fs.readFileSync(path.join(worktreeDir, "partial.ts"), "utf8")).toContain("partial = true");
  }, 15_000);

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

  it("routes a structured approved review straight to exactly-once delivery without budget elevation", async () => {
    const projectDir = path.join(tempDir, "project");
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "approval", path: projectDir });
    const task = database.createTask("approve and deliver once", "dashboard", "approval");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-approval",
      worktreePath: worktreeDir
    });

    let reviewCalls = 0;
    let deliveryCalls = 0;
    const provider = new FakeProvider(
      "codex",
      ["planning", "coding", "testing", "reviewing"],
      (request) => {
        if (request.phase === "reviewing") {
          reviewCalls += 1;
          return {
            outcome: "completed",
            summary: "approved by structured review",
            output: "approved",
            error: null,
            durationMs: 1,
            retryable: false,
            structuredPayload: { reviewDecision: "approved" }
          };
        }
        return completed(`${request.phase} done`);
      }
    );

    const run = await runTaskGoal(database, new AgentRegistry([provider]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 6,
      delivery: async () => {
        deliveryCalls += 1;
        return {
          commitSha: "abc123",
          pullRequestUrl: "https://github.com/example/repo/pull/7",
          branchName: "maestro/task-approval"
        };
      }
    });

    expect(run.status).toBe("completed");
    expect(reviewCalls).toBe(1);
    expect(deliveryCalls).toBe(1);
    expect(run.commitSha).toBe("abc123");
    expect(run.pullRequestUrl).toBe("https://github.com/example/repo/pull/7");
    expect(database.getTask(task.id).status).toBe("awaiting_human");
    expect(database.listEvents().filter((event) => event.type === "goal.delivered")).toHaveLength(1);
    expect(database.listEvents().filter((event) => event.type === "goal.budget_elevated")).toHaveLength(0);
    expect(database.listEvents().filter((event) => event.type === "goal.completed")).toHaveLength(1);
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
          return {
            outcome: "failed",
            summary: "quota",
            output: "",
            error: "quota",
            durationMs: 1,
            retryable: true,
            retryAfterMs: 10 * 60_000,
            failureCategory: "quota"
          };
        }
        return completed("available");
      }
    );
    const scheduler = new ManualScheduler();
    let registryNow = Date.now();
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([codex], undefined, () => registryNow),
      path.join(tempDir, "artifacts"),
      20,
      undefined,
      undefined,
      undefined,
      scheduler
    );

    const run = coordinator.start(task.id, 8);
    await waitFor(() => database.getGoalRun(run.id).status === "waiting_provider");
    const waitingRun = database.getGoalRun(run.id);
    expect(waitingRun.nextRetryAt).not.toBeNull();
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.pendingDelaysMs[0]).toBeGreaterThan(50_000);
    registryNow += 10 * 60_000 + 1;
    scheduler.flush();
    await waitFor(() => database.getGoalRun(run.id).status === "completed");

    expect(database.getTask(task.id).status).toBe("done");
    expect(database.getGoalRun(run.id).stepCount).toBe(4);
    expect(database.listGoalSteps(run.id)).toHaveLength(5);
    expect(database.listEvents().some((event) => event.type === "goal.waiting_provider")).toBe(true);
    expect(database.listEvents().some((event) => event.type === "goal.resumed")).toBe(true);
    coordinator.shutdown();
  });

  it("creates a durable waiting Goal when provider preflight reports quota", async () => {
    const projectDir = path.join(tempDir, "preflight-quota-project");
    const worktreeDir = path.join(tempDir, "preflight-quota-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "preflight-quota", path: projectDir });
    const task = database.createTask("wait durably for provider quota", "dashboard", "preflight-quota");
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/task-preflight-quota",
      worktreePath: worktreeDir
    });
    const quotaProvider: AgentProvider = {
      id: "codex",
      label: "Codex",
      capabilities: new Set(["planning"]),
      health: async () => ({ state: "quota", detail: "quota", checkedAt: new Date().toISOString() }),
      execute: async () => completed("unexpected")
    };
    const scheduler = new ManualScheduler();
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([quotaProvider]),
      path.join(tempDir, "artifacts"),
      20,
      undefined,
      undefined,
      undefined,
      scheduler,
      undefined,
      () => ({
        status: "quota",
        summary: "No provider currently has quota.",
        recommendedAction: "Wait for quota reset.",
        checkedAt: new Date().toISOString(),
        projectKey: "preflight-quota",
        taskId: task.id,
        fingerprintId: "quota-test",
        requiredCapabilities: ["planning"],
        checks: []
      })
    );

    const run = coordinator.start(task.id, 6);
    await waitFor(() => database.getGoalRun(run.id).status === "waiting_provider");

    expect(database.getGoalRun(run.id).waitReason).toBe("quota");
    expect(database.getTask(task.id).status).toBe("waiting_provider");
    expect(database.listEvents().some((event) => event.type === "goal.provider_preflight_wait")).toBe(true);
    expect(scheduler.pendingCount).toBe(1);
    coordinator.shutdown();
  });

  it("recovers an interrupted runtime step from the preserved worktree and checkpoint", async () => {
    const worktreeDir = path.join(tempDir, "restart-worktree");
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "restart", path: worktreeDir });
    const task = database.createTask("resume partial implementation after restart", "dashboard", "restart");
    database.updateTaskWorktree({
      id: task.id,
      status: "implementing",
      branchName: "maestro/task-restart",
      worktreePath: worktreeDir
    });
    const run = database.createGoalRun(task.id, 6);
    database.updateGoalRun({
      id: run.id,
      status: "running",
      currentPhase: "implementing",
      stepCount: 0,
      lastProvider: "codex"
    });
    const interruptedStep = database.createGoalStep(run.id, "implementing", "codex");
    fs.writeFileSync(path.join(worktreeDir, "partial.ts"), "export const preserved = true;\n", "utf8");

    let implementationResumeContext: string | undefined;
    const codex = new FakeProvider(
      "codex",
      ["coding", "testing", "reviewing"],
      (request) => {
        if (request.phase === "implementing") implementationResumeContext = request.resumeContext;
        return completed("continued from preserved work");
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

    expect(coordinator.recoverWaitingRuns()).toBe(1);
    const waitingRun = database.getGoalRun(run.id);
    expect(waitingRun.status).toBe("waiting_provider");
    expect(waitingRun.waitReason).toBe("runtime_restart");
    expect(database.getTask(task.id).status).toBe("waiting_provider");
    expect(database.getGoalStep(interruptedStep.id).status).toBe("cancelled");
    expect(database.getLatestGoalCheckpoint(run.id)).toMatchObject({
      status: "interrupted",
      changedFiles: ["partial.ts"]
    });
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.pendingDelaysMs[0]).toBeGreaterThan(0);
    expect(scheduler.pendingDelaysMs[0]).toBeLessThanOrEqual(5_000);

    scheduler.flush();
    await waitFor(() => database.getGoalRun(run.id).status === "completed");

    expect(implementationResumeContext).toContain("partial.ts");
    expect(implementationResumeContext).toContain("Nao reverta nem refaca trabalho valido");
    expect(database.getTask(task.id).status).toBe("done");
    expect(database.listEvents().some((event) => event.type === "goal.recovered_after_restart")).toBe(true);
    coordinator.shutdown();
  });

  it("does not recover a Goal owned by another resident coordinator", () => {
    const projectDir = path.join(tempDir, "owned-run-project");
    fs.mkdirSync(projectDir);
    initializeRepository(projectDir);
    database.registerProject({ key: "owned-run", path: projectDir });
    const task = database.createTask("leave owned run untouched", "dashboard", "owned-run");
    database.updateTaskWorktree({
      id: task.id,
      status: "implementing",
      branchName: "maestro/task-owned-run",
      worktreePath: projectDir
    });
    const run = database.createGoalRun(task.id, 6);
    const step = database.createGoalStep(run.id, "implementing", "codex");
    const scheduler = new ManualScheduler();
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([]),
      path.join(tempDir, "artifacts"),
      20,
      undefined,
      undefined,
      undefined,
      scheduler
    );

    expect(coordinator.recoverWaitingRuns((candidate) => candidate.id === run.id)).toBe(0);
    expect(database.getGoalRun(run.id).status).toBe("running");
    expect(database.getGoalStep(step.id).status).toBe("running");
    expect(database.getTask(task.id).status).toBe("implementing");
    expect(scheduler.pendingCount).toBe(0);
    coordinator.shutdown();
  });

  it("fails closed during restart recovery when the recorded worktree is missing", () => {
    const projectDir = path.join(tempDir, "missing-worktree-project");
    fs.mkdirSync(projectDir);
    database.registerProject({ key: "missing-worktree", path: projectDir });
    const task = database.createTask("recover only from preserved state", "dashboard", "missing-worktree");
    database.updateTaskWorktree({
      id: task.id,
      status: "implementing",
      branchName: "maestro/task-missing-worktree",
      worktreePath: path.join(tempDir, "does-not-exist")
    });
    const run = database.createGoalRun(task.id, 6);
    database.updateGoalRun({
      id: run.id,
      status: "running",
      currentPhase: "implementing",
      stepCount: 0,
      lastProvider: "codex"
    });
    const step = database.createGoalStep(run.id, "implementing", "codex");
    const scheduler = new ManualScheduler();
    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([]),
      path.join(tempDir, "artifacts"),
      20,
      undefined,
      undefined,
      undefined,
      scheduler
    );

    expect(coordinator.recoverWaitingRuns()).toBe(0);
    expect(database.getGoalRun(run.id).status).toBe("blocked");
    expect(database.getGoalStep(step.id).status).toBe("blocked");
    expect(database.getTask(task.id).status).toBe("blocked");
    expect(scheduler.pendingCount).toBe(0);
    expect(database.listEvents().some((event) => event.type === "goal.recovery_blocked")).toBe(true);
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

  it("blocks the goal run when a per-phase budget is exhausted", async () => {
    const projectDir = path.join(tempDir, "phase-budget-project");
    const worktreeDir = path.join(tempDir, "phase-budget-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    initializeRepository(worktreeDir);
    database.registerProject({ key: "phasebudget", path: projectDir });
    const task = database.createTask("planning heavy task", "dashboard", "phasebudget");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    let calls = 0;
    const provider1 = new FakeProvider("codex", ["planning"], () => {
      calls++;
      return { outcome: "failed", summary: "planning error alpha", output: "", error: "planning error alpha", durationMs: 1, retryable: true };
    });
    const provider2 = new FakeProvider("claude", ["planning"], () => {
      calls++;
      return { outcome: "failed", summary: "planning error beta", output: "", error: "planning error beta", durationMs: 1, retryable: true };
    });

    const run = await runTaskGoal(database, new AgentRegistry([provider1, provider2]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 10,
      phaseBudgets: { planning: 2 }
    });

    expect(run.status).toBe("waiting_provider");
    expect(run.waitReason).toBe("budget_exhausted");
    expect(run.lastError).toBe("Phase 'planning' reached its limit of 2 steps.");
    expect(calls).toBe(2);

    const circuitBreakerEvent = database.listEvents().find((e) => e.type === "goal.circuit_breaker");
    expect(circuitBreakerEvent?.metadata).toMatchObject({
      reason: "phase_budget_exhausted",
      phase: "planning",
      worktreePreserved: true
    });
  });

  it("auto-elevates budget on budget trip with no loop signal and transitions to waiting_provider", async () => {
    const projectDir = path.join(tempDir, "auto-budget-project");
    const worktreeDir = path.join(tempDir, "auto-budget-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "autobudget", path: projectDir });
    const task = database.createTask("auto budget task", "dashboard", "autobudget");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    let stepCount = 0;
    const provider = new FakeProvider("codex", ["planning", "coding", "testing", "reviewing"], () => {
      stepCount++;
      return completed(`step ${stepCount}`);
    });
    const registry = new AgentRegistry([provider]);

    const run1 = await runTaskGoal(database, registry, task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 2
    });
    expect(run1.status).toBe("waiting_provider");
    expect(run1.waitReason).toBe("budget_exhausted");
    expect(run1.maxSteps).toBeGreaterThan(2);

    const events1 = database.listEvents().filter((e) => e.type === "goal.budget_elevated");
    expect(events1.length).toBe(1);
    expect(events1[0].metadata).toMatchObject({
      runId: run1.id,
      previousMaxSteps: 2,
      source: "auto_budget_exhausted"
    });
  });

  it("retryRun raises maxSteps, logs goal.budget_elevated, and allows goal to proceed past old cap", async () => {
    const projectDir = path.join(tempDir, "retry-budget-project");
    const worktreeDir = path.join(tempDir, "retry-budget-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "retrybudget", path: projectDir });
    const task = database.createTask("retry budget task", "dashboard", "retrybudget");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([new FakeProvider("codex", ["planning"], () => completed("step"))]),
      path.join(tempDir, "artifacts")
    );

    const run = database.createGoalRun(task.id, 4);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "planning",
      stepCount: 4,
      lastError: "Goal reached its 4-step budget.",
      failureCategory: "budget_exhausted"
    });

    const retried = coordinator.retryRun(run.id);
    expect(retried.status).toBe("waiting_provider");
    expect(retried.maxSteps).toBeGreaterThanOrEqual(6);

    const events = database.listEvents();
    const elevatedEvent = events.find((e) => e.type === "goal.budget_elevated");
    expect(elevatedEvent).toBeTruthy();
    expect(elevatedEvent?.metadata).toMatchObject({
      runId: run.id,
      previousMaxSteps: 4,
      newMaxSteps: 6,
      source: "retry_run"
    });
  });

  it("retryRun never shrinks maxSteps when the run already exceeds the ceiling", async () => {
    const projectDir = path.join(tempDir, "retry-ceiling-project");
    const worktreeDir = path.join(tempDir, "retry-ceiling-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "retryceiling", path: projectDir });
    const task = database.createTask("retry ceiling task", "dashboard", "retryceiling");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([new FakeProvider("codex", ["planning"], () => completed("step"))]),
      path.join(tempDir, "artifacts")
    );

    // A DNA-based run may already exceed MAESTRO_GOAL_MAX_STEPS (targeted no-cap runs).
    const run = database.createGoalRun(task.id, 150);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "planning",
      stepCount: 150,
      lastError: "Goal reached its 150-step budget.",
      failureCategory: "budget_exhausted"
    });

    const retried = coordinator.retryRun(run.id);
    // Must NOT lower the budget below the existing ceiling.
    expect(retried.status).toBe("waiting_provider");
    expect(retried.maxSteps).toBeGreaterThanOrEqual(150);
  });

  it("counts only automatic budget elevations toward the auto-retry cap", async () => {
    const projectDir = path.join(tempDir, "auto-count-project");
    const worktreeDir = path.join(tempDir, "auto-count-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "autocount", path: projectDir });
    const task = database.createTask("auto count task", "dashboard", "autocount");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });
    const run = database.createGoalRun(task.id, 2);

    database.addEvent({
      source: "human",
      type: "goal.budget_elevated",
      text: "manual",
      taskId: task.id,
      metadata: { runId: run.id, source: "retry_run" }
    });
    database.addEvent({
      source: "system",
      type: "goal.budget_elevated",
      text: "auto",
      taskId: task.id,
      metadata: { runId: run.id, source: "auto_budget_exhausted" }
    });
    // Only the automatic one counts, so a manual retry does not consume an auto slot.
    expect(database.countBudgetElevationsForRun(run.id)).toBe(1);
  });

  it("loop-flagged goals stay blocked and retryRun refuses to auto-retry non-budget failures", async () => {
    const projectDir = path.join(tempDir, "loop-blocked-project");
    const worktreeDir = path.join(tempDir, "loop-blocked-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "loopblocked", path: projectDir });
    const task = database.createTask("loop blocked task", "dashboard", "loopblocked");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const coordinator = new GoalCoordinator(
      database,
      new AgentRegistry([new FakeProvider("codex", ["planning"], () => completed("step"))]),
      path.join(tempDir, "artifacts")
    );

    const run = database.createGoalRun(task.id, 10);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "implementing",
      stepCount: 3,
      lastError: "implementing completed repeatedly without changing the worktree.",
      failureCategory: "loop"
    });

    expect(() => coordinator.retryRun(run.id)).toThrow(
      `Goal #${run.id} is not blocked by budget-exhausted (category: loop); refusing to auto-retry other failures.`
    );
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
