import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-test-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("database", () => {
  it("registers projects", () => {
    const project = database.registerProject({
      key: "octomynd",
      name: "Octomynd",
      path: tempDir,
      defaultBranch: "main"
    });

    expect(project.key).toBe("octomynd");
    expect(project.name).toBe("Octomynd");
    expect(database.listProjects()).toHaveLength(1);
  });

  it("creates and lists tasks", () => {
    database.registerProject({
      key: "octomynd",
      path: tempDir
    });

    const task = database.createTask("test telegram integration", "telegram", "octomynd");

    expect(task.id).toBeGreaterThan(0);
    expect(task.projectKey).toBe("octomynd");
    expect(task.status).toBe("queued");
    expect(database.listTasks()).toHaveLength(1);
    expect(database.listTasksByProject("octomynd")).toHaveLength(1);
  });

  it("stores events", () => {
    const task = database.createTask("task with event");
    const event = database.addEvent({
      source: "telegram",
      type: "task.created",
      text: task.text,
      userId: "123",
      taskId: task.id
    });

    expect(event.id).toBeGreaterThan(0);
    expect(event.taskId).toBe(task.id);
    expect(database.getLastEvent()?.type).toBe("task.created");
    expect(database.listEvents()).toHaveLength(1);
  });

  it("stores auditable task reviews", () => {
    const task = database.createTask("review visual platform");
    const review = database.addTaskReview({
      taskId: task.id,
      provider: "claude",
      status: "completed",
      content: "Aprovado com ajustes."
    });

    expect(review.provider).toBe("claude");
    expect(review.status).toBe("completed");
    expect(database.listTaskReviews(task.id)).toEqual([review]);
  });

  it("keeps improvement proposals pending until a human decision", () => {
    const proposal = database.createImprovementProposal({
      category: "skill",
      title: "Reuse Telegram retry procedure",
      rationale: "The same recovery sequence succeeded in two integration tasks.",
      proposedChange: "Create a reusable Telegram delivery troubleshooting skill.",
      evidence: ["task:3", "review:7"],
      risk: "medium",
      source: "background-review"
    });

    expect(proposal.status).toBe("candidate");
    expect(proposal.evidence).toEqual(["task:3", "review:7"]);
    expect(database.countImprovementProposalsByStatus()).toEqual({ candidate: 1 });

    const approved = database.decideImprovementProposal(
      proposal.id,
      "approved",
      "Implement in an isolated worktree."
    );
    expect(approved.status).toBe("approved");
    expect(approved.decisionNote).toContain("isolated worktree");
    expect(() => database.decideImprovementProposal(proposal.id, "rejected")).toThrow(
      "no longer awaiting a decision"
    );
  });

  it("stores human review decisions and reopens completed goals", () => {
    const task = database.createTask("review me");
    const run = database.createGoalRun(task.id, 4);
    database.updateGoalRun({ id: run.id, status: "completed", currentPhase: "reviewing", stepCount: 4 });

    const review = database.addHumanReview({
      runId: run.id,
      decision: "changes_requested",
      note: "Add an integration test."
    });
    const reopened = database.reopenGoalRun(run.id);

    expect(review.taskId).toBe(task.id);
    expect(database.getLatestHumanReview(run.id)).toEqual(review);
    expect(reopened.status).toBe("running");
    expect(reopened.currentPhase).toBe("implementing");
    expect(reopened.maxSteps).toBe(8);
    expect(reopened.finishedAt).toBeNull();
  });
});
