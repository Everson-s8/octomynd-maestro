import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentExecutionResult } from "../src/agents/types.js";
import { captureWorkspaceProgress, GoalCircuitBreaker, DEFAULT_PHASE_BUDGETS } from "../src/goals/circuit-breaker.js";

describe("GoalCircuitBreaker", () => {
  it("blocks a repeated provider failure after the second occurrence", () => {
    const breaker = new GoalCircuitBreaker();
    const observation = {
      phase: "implementing" as const,
      result: failed("same timeout 123"),
      workspaceBefore: "a",
      workspaceAfter: "a"
    };

    expect(breaker.observe(observation)).toBeNull();
    expect(breaker.observe({ ...observation, result: failed("same timeout 456") })).toMatchObject({
      reason: "repeated_failure"
    });
  });

  it("blocks repeated writable phases that make no worktree progress", () => {
    const breaker = new GoalCircuitBreaker();
    const observation = {
      phase: "testing" as const,
      result: completed(),
      workspaceBefore: "same",
      workspaceAfter: "same"
    };

    expect(breaker.observe(observation)).toBeNull();
    expect(breaker.observe(observation)).toMatchObject({ reason: "no_progress" });
  });

  it("resets no-progress tracking after the worktree changes", () => {
    const breaker = new GoalCircuitBreaker();
    expect(breaker.observe({
      phase: "implementing",
      result: completed(),
      workspaceBefore: "a",
      workspaceAfter: "a"
    })).toBeNull();
    expect(breaker.observe({
      phase: "implementing",
      result: completed(),
      workspaceBefore: "a",
      workspaceAfter: "b"
    })).toBeNull();
    expect(breaker.observe({
      phase: "implementing",
      result: completed(),
      workspaceBefore: "b",
      workspaceAfter: "b"
    })).toBeNull();
  });

  it("blocks process output breakers immediately", () => {
    const breaker = new GoalCircuitBreaker();
    const result = failed("flood");
    result.processRuntime = {
      breakerReason: "duplicate_output",
      outputStats: { receivedChars: 1000, retainedChars: 10, duplicateChunks: 80, truncatedChars: 990 }
    };

    expect(breaker.observe({
      phase: "implementing",
      result,
      workspaceBefore: "a",
      workspaceAfter: "a"
    })).toMatchObject({ reason: "duplicate_output" });
  });

  it("detects content changes inside an existing untracked file", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-progress-"));
    try {
      initializeRepository(worktree);
      const untracked = path.join(worktree, "new-file.txt");
      fs.writeFileSync(untracked, "first", "utf8");
      const before = captureWorkspaceProgress(worktree);
      fs.writeFileSync(untracked, "second", "utf8");
      const after = captureWorkspaceProgress(worktree);

      expect(before).not.toBeNull();
      expect(after).not.toBe(before);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("exports default phase budgets and enforces them", () => {
    expect(DEFAULT_PHASE_BUDGETS).toEqual({
      planning: 3,
      implementing: 6,
      testing: 4,
      reviewing: 3
    });

    const breaker = new GoalCircuitBreaker({ planning: 2 });
    const observation = {
      phase: "planning" as const,
      result: completed(),
      workspaceBefore: "a",
      workspaceAfter: "b"
    };

    expect(breaker.observe(observation)).toBeNull();
    expect(breaker.observe(observation)).toMatchObject({
      reason: "phase_budget_exhausted",
      summary: "Phase 'planning' reached its limit of 2 steps."
    });
  });

  it("restores phase step counts from steps and checks phase budget before execution", () => {
    const dummyStep = (phase: "planning" | "implementing", status: "completed" | "failed" = "completed") => ({
      id: 1,
      runId: 1,
      phase,
      provider: "fake",
      status,
      summary: "step",
      output: "",
      error: null,
      durationMs: 10,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    });

    const steps = [dummyStep("planning"), dummyStep("planning"), dummyStep("planning")];
    const breaker = GoalCircuitBreaker.fromSteps(steps, { planning: 3 });

    expect(breaker.checkPhaseBudget("planning")).toMatchObject({
      reason: "phase_budget_exhausted",
      summary: "Phase 'planning' reached its limit of 3 steps."
    });
    expect(breaker.checkPhaseBudget("implementing")).toBeNull();
  });
});

function initializeRepository(directory: string): void {
  execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "maestro@example.test"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Maestro Test"], { cwd: directory });
  fs.writeFileSync(path.join(directory, "README.md"), "fixture", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: directory });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: directory, stdio: "ignore" });
}

function failed(error: string): AgentExecutionResult {
  return {
    outcome: "failed",
    summary: error,
    output: "",
    error,
    durationMs: 1,
    retryable: true
  };
}

function completed(): AgentExecutionResult {
  return {
    outcome: "completed",
    summary: "done",
    output: "",
    error: null,
    durationMs: 1,
    retryable: false
  };
}
