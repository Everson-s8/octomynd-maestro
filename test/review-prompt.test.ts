import { describe, expect, it } from "vitest";
import {
  buildReviewPhaseInstruction,
  buildReviewPrompt,
  TEXT_REVIEW_VERDICT
} from "../src/agents/review-prompt.js";
import { buildAgentGoalPrompt } from "../src/agents/goal-prompt.js";
import type { AgentExecutionRequest } from "../src/agents/types.js";
import type { ProjectRecord, TaskRecord } from "../src/db.js";

function project(): ProjectRecord {
  return {
    id: 1,
    key: "maestro",
    name: "Octomynd Maestro",
    path: "C:/repo/maestro",
    defaultBranch: "main",
    createdAt: "now",
    updatedAt: "now"
  };
}

function task(): TaskRecord {
  return {
    id: 9,
    projectId: 1,
    projectKey: "maestro",
    projectName: "Octomynd Maestro",
    text: "revisar a identidade visual",
    status: "planning",
    source: "dashboard",
    branchName: "maestro/task-9-review",
    worktreePath: "C:/worktrees/task-9",
    createdAt: "now",
    updatedAt: "now"
  };
}

function reviewingRequest(): AgentExecutionRequest {
  return {
    runId: 1,
    stepNumber: 1,
    phase: "reviewing",
    capability: "reviewing",
    task: task(),
    project: project(),
    previousSteps: [],
    artifactsRoot: "C:/worktree/../artifacts"
  };
}

describe("review prompt (provider-agnostic)", () => {
  it("builds a standalone acceptance review prompt with task context", () => {
    const prompt = buildReviewPrompt(task(), project());

    expect(prompt).toContain("read-only mode");
    expect(prompt).toContain("Task #9: revisar a identidade visual");
    expect(prompt).toContain("docs/VISUAL_IDENTITY.md");
    // Acceptance-based, not an open-ended design critique.
    expect(prompt).toContain("acceptance criteria");
    expect(prompt).toContain("FINAL_REVIEW_DECISION");
    expect(prompt).not.toContain("five improvements");
    expect(prompt).not.toContain("strengths");
  });

  it("does not hardcode any provider", () => {
    const prompt = buildReviewPrompt(task(), project());

    expect(prompt).not.toContain("Claude");
    expect(prompt).not.toContain("Codex");
    expect(prompt).not.toContain("Antigravity");
  });

  it("phase instruction encodes the same acceptance rules", () => {
    const instruction = buildReviewPhaseInstruction(TEXT_REVIEW_VERDICT);

    expect(instruction).toContain("acceptance reviewer");
    expect(instruction).toContain("REQUEST CHANGES only");
    expect(instruction).toContain("do NOT justify changes_requested");
    expect(instruction).toContain("FINAL_REVIEW_DECISION");
  });

  it("goal-loop reviewing phase reuses the shared instruction", () => {
    const prompt = buildAgentGoalPrompt(reviewingRequest());

    expect(prompt).toContain("acceptance reviewer");
    expect(prompt).toContain("REQUEST CHANGES only");
    expect(prompt).toContain("do NOT justify changes_requested");
  });
});
