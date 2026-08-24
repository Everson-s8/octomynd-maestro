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

  it("does not turn provider permission failures into a task-split verdict", () => {
    const breaker = new GoalCircuitBreaker();
    const phases = ["planning", "implementing", "testing"] as const;
    for (const [index, phase] of phases.entries()) {
      expect(breaker.observe({
        phase,
        provider: "antigravity",
        result: {
          ...failed(`permission check failed for command ${index}`),
          failureCategory: "permission_denied"
        },
        workspaceBefore: String(index),
        workspaceAfter: String(index)
      })).toBeNull();
    }
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
    const progressObservation = {
      phase: "planning" as const,
      result: completed(),
      workspaceBefore: "a",
      workspaceAfter: "b"
    };

    // With measurable worktree progress, the phase-budget check must NOT block:
    // a task making forward progress is legitimately iterating, not looping.
    expect(breaker.observe(progressObservation)).toBeNull();
    expect(breaker.observe(progressObservation)).toBeNull();

    // Without progress (unchanged worktree), the ceiling is still enforced.
    const stuckObservation = {
      phase: "planning" as const,
      result: completed(),
      workspaceBefore: "same",
      workspaceAfter: "same"
    };
    const stuck = new GoalCircuitBreaker({ planning: 2 });
    stuck.observe(stuckObservation);
    expect(stuck.observe(stuckObservation)).toMatchObject({
      reason: "phase_budget_exhausted",
      summary: "Phase 'planning' reached its limit of 2 steps without measurable progress."
    });
  });

  it("does not kill a reviewing goal when the worktree is stable", () => {
    // Reviews read the diff and produce evidence; they never write the
    // worktree. So the worktree hash stays identical across review steps even
    // when the goal is legitimately iterating its review cycle (e.g. a review
    // that requests changes, the changes are already applied, and the reviewer
    // re-examines). Blocking on 'stable worktree' would kill every real review
    // cycle.
    const breaker = new GoalCircuitBreaker({ reviewing: 2 });
    const observation = {
      phase: "reviewing" as const,
      result: completed(),
      workspaceBefore: "SAME",
      workspaceAfter: "SAME"
    };
    expect(breaker.observe(observation)).toBeNull();
    expect(breaker.observe(observation)).toBeNull();
    // Even a third review pass with a stable worktree must not be hard-stopped:
    // the reviewer is doing its job even though it doesn't touch files.
    expect(breaker.observe(observation)).toBeNull();
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

    // checkPhaseBudget is now a generous safety ceiling (3x the phase budget),
    // not the primary loop guard — precise loop detection is progress-aware in
    // observe(). At the normal budget (3 here) it must NOT block.
    const normalSteps = [dummyStep("planning"), dummyStep("planning"), dummyStep("planning")];
    const normalBreaker = GoalCircuitBreaker.fromSteps(normalSteps, { planning: 3 });
    expect(normalBreaker.checkPhaseBudget("planning")).toBeNull();

    // It only trips once the count blows past 3x the phase budget (a runaway net).
    const runaway = Array.from({ length: 9 }, () => dummyStep("planning"));
    const runawayBreaker = GoalCircuitBreaker.fromSteps(runaway, { planning: 3 });
    expect(runawayBreaker.checkPhaseBudget("planning")).toMatchObject({
      reason: "phase_budget_exhausted",
      summary: "Phase 'planning' exceeded safety ceiling (9 steps)."
    });
    expect(runawayBreaker.checkPhaseBudget("implementing")).toBeNull();
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
