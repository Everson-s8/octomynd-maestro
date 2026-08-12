import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import {
  AgentCapability,
  AgentExecutionResult,
  AgentProvider
} from "../src/agents/types.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { isSmallTask, GoalCircuitBreaker } from "../src/goals/circuit-breaker.js";
import { runTaskGoal } from "../src/goals/runner.js";

class FakeProvider implements AgentProvider {
  readonly label: string;
  readonly capabilities: ReadonlySet<AgentCapability>;

  constructor(
    readonly id: "codex" | "claude" | "antigravity",
    capabilities: AgentCapability[],
    private readonly handler: (req: any) => AgentExecutionResult
  ) {
    this.label = id;
    this.capabilities = new Set(capabilities);
  }

  async health() {
    return { state: "ready" as const, detail: "test", checkedAt: new Date().toISOString() };
  }

  async execute(req: any): Promise<AgentExecutionResult> {
    return this.handler(req);
  }
}

function failed(error: string, retryable = true, failureCategory?: any): AgentExecutionResult {
  return {
    outcome: "failed",
    summary: error,
    output: "",
    error,
    durationMs: 10,
    retryable,
    failureCategory
  };
}

function completed(summary: string): AgentExecutionResult {
  return {
    outcome: "completed",
    summary,
    output: summary,
    error: null,
    durationMs: 10,
    retryable: false
  };
}

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-brain-test-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Failure Recovery Brain - isSmallTask", () => {
  it("classifies task text with small task keywords as small", () => {
    expect(isSmallTask("small task: fix typo in docs")).toBe(true);
    expect(isSmallTask("pequena alteracao de dependencia")).toBe(true);
  });

  it("classifies long task text or text with complexity signals as not small", () => {
    expect(isSmallTask("a".repeat(160))).toBe(false);
    expect(isSmallTask("fix bug; update tests and docs")).toBe(false);
    expect(isSmallTask("refactor authentication pipeline")).toBe(false);
  });

  it("respects explicit task metadata overrides", () => {
    expect(isSmallTask("long task text " + "a".repeat(200), { isSmallTask: true })).toBe(true);
    expect(isSmallTask("fix typo", { isSmallTask: false })).toBe(false);
  });
});

describe("Failure Recovery Brain - GoalCircuitBreaker", () => {
  it("triggers small_task_failure_limit after 2 consecutive failures on a small task", () => {
    const breaker = new GoalCircuitBreaker();
    const obs1 = breaker.observe({
      phase: "implementing",
      result: failed("failed once"),
      workspaceBefore: null,
      workspaceAfter: null,
      taskText: "small task: fix typo"
    });
    expect(obs1).toBeNull();

    const obs2 = breaker.observe({
      phase: "implementing",
      result: failed("failed twice"),
      workspaceBefore: null,
      workspaceAfter: null,
      taskText: "small task: fix typo"
    });
    expect(obs2?.reason).toBe("small_task_failure_limit");
    expect(obs2?.summary).toContain("Small task failed 2 consecutive times");
  });

  it("resets consecutive counter on completed step so 2nd total failure does not trigger small task limit if interrupted by success", () => {
    const breaker = new GoalCircuitBreaker();
    breaker.observe({
      phase: "implementing",
      result: failed("failed once"),
      workspaceBefore: null,
      workspaceAfter: null,
      taskText: "small task: fix typo"
    });
    breaker.observe({
      phase: "implementing",
      result: completed("done step 1"),
      workspaceBefore: "a",
      workspaceAfter: "b",
      taskText: "small task: fix typo"
    });

    const obs3 = breaker.observe({
      phase: "implementing",
      result: failed("failed step 2"),
      workspaceBefore: "b",
      workspaceAfter: "b",
      taskText: "small task: fix typo"
    });
    expect(obs3).toBeNull();
  });

  it("triggers task_split_required after 3 failures on a large task", () => {
    const breaker = new GoalCircuitBreaker();
    const taskText = "refactor database integration pipeline and migrate schema";

    expect(breaker.observe({ phase: "implementing", result: failed("err1"), workspaceBefore: null, workspaceAfter: null, taskText })).toBeNull();
    expect(breaker.observe({ phase: "implementing", result: failed("err2"), workspaceBefore: null, workspaceAfter: null, taskText })).toBeNull();

    const obs3 = breaker.observe({ phase: "implementing", result: failed("err3"), workspaceBefore: null, workspaceAfter: null, taskText });
    expect(obs3?.reason).toBe("task_split_required");
    expect(obs3?.summary).toContain("split into smaller sub-tasks");
  });

  it("triggers prompt_too_large immediately when provider fails with prompt_too_large category", () => {
    const breaker = new GoalCircuitBreaker();
    const obs = breaker.observe({
      phase: "implementing",
      result: failed("ENAMETOOLONG: argument list too long", false, "prompt_too_large"),
      workspaceBefore: null,
      workspaceAfter: null,
      taskText: "some task"
    });
    expect(obs?.reason).toBe("prompt_too_large");
    expect(obs?.summary).toContain("Prompt-bloat detected");
  });
});

describe("Failure Recovery Brain - Goal Runner Integration", () => {
  it("stops retrying after 2 consecutive failures on a small task and emits circuit breaker event", async () => {
    const projectDir = path.join(tempDir, "small-project");
    const worktreeDir = path.join(tempDir, "small-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "small", path: projectDir });
    const task = database.createTask("fix typo in readme (small task)", "dashboard", "small");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const p1 = new FakeProvider("codex", ["planning", "coding"], () => failed("codex fail"));
    const p2 = new FakeProvider("claude", ["planning", "coding"], () => failed("claude fail"));

    const run = await runTaskGoal(database, new AgentRegistry([p1, p2]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 10
    });

    expect(run.status).toBe("blocked");
    const events = database.listEvents();
    const breakerEvent = events.find((e) => e.type === "goal.circuit_breaker");
    expect(breakerEvent).toBeDefined();
    expect(breakerEvent?.metadata.reason).toBe("small_task_failure_limit");
    expect(breakerEvent?.text).toContain("Small task failed 2 consecutive times");
  });

  it("stops retrying and flags task_split_required after 3 failures on a large task", async () => {
    const projectDir = path.join(tempDir, "large-project");
    const worktreeDir = path.join(tempDir, "large-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "large", path: projectDir });
    const task = database.createTask("refactor authentication pipeline and migrate user table schema across modules", "dashboard", "large");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const p1 = new FakeProvider("codex", ["planning", "coding"], () => failed("err codex"));
    const p2 = new FakeProvider("claude", ["planning", "coding"], () => failed("err claude"));
    const p3 = new FakeProvider("antigravity", ["planning", "coding"], () => failed("err antigravity"));

    const run = await runTaskGoal(database, new AgentRegistry([p1, p2, p3]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 10,
      phaseBudgets: { planning: 5 }
    });

    expect(run.status).toBe("blocked");
    const events = database.listEvents();
    const breakerEvent = events.find((e) => e.type === "goal.circuit_breaker");
    expect(breakerEvent).toBeDefined();
    expect(breakerEvent?.metadata.reason).toBe("task_split_required");
    expect(breakerEvent?.text).toContain("split into smaller sub-tasks");
  });

  it("stops execution immediately when ENAMETOOLONG / prompt_too_large occurs", async () => {
    const projectDir = path.join(tempDir, "bloat-project");
    const worktreeDir = path.join(tempDir, "bloat-worktree");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    database.registerProject({ key: "bloat", path: projectDir });
    const task = database.createTask("some task", "dashboard", "bloat");
    database.updateTaskWorktree({ id: task.id, status: "planning", branchName: "task", worktreePath: worktreeDir });

    const p1 = new FakeProvider("codex", ["planning", "coding"], () => failed("spawn ENAMETOOLONG", false, "prompt_too_large"));
    const p2 = new FakeProvider("claude", ["planning", "coding"], () => completed("should not be called"));

    const run = await runTaskGoal(database, new AgentRegistry([p1, p2]), task.id, {
      artifactsRoot: path.join(tempDir, "artifacts"),
      maxSteps: 10
    });

    expect(run.status).toBe("blocked");
    const events = database.listEvents();
    const breakerEvent = events.find((e) => e.type === "goal.circuit_breaker");
    expect(breakerEvent?.metadata.reason).toBe("prompt_too_large");
  });
});
