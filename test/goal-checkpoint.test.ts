import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase, GoalCheckpointRecord } from "../src/db.js";
import { captureGoalCheckpoint, formatCheckpointForResume } from "../src/goals/checkpoint.js";

let database: MaestroDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-checkpoint-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, windowsHide: true });
  fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: tempDir, windowsHide: true });
  execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, windowsHide: true });
  database = createDatabase(path.join(tempDir, ".maestro", "maestro.db"));
  database.registerProject({ key: "maestro", path: tempDir });
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Goal checkpoint", () => {
  it("persists interrupted workspace evidence and formats a bounded resume handoff", () => {
    const task = database.createTask("Implement resumable execution", "test", "maestro");
    database.updateTaskWorktree({
      id: task.id,
      status: "implementing",
      branchName: "task",
      worktreePath: tempDir
    });
    const run = database.createGoalRun(task.id);
    const step = database.createGoalStep(run.id, "implementing", "codex");
    fs.writeFileSync(path.join(tempDir, "partial.ts"), "export const partial = true;\n");

    const checkpoint = database.createGoalCheckpoint(captureGoalCheckpoint({
      runId: run.id,
      stepId: step.id,
      phase: "implementing",
      provider: "codex",
      interrupted: true,
      summary: "Provider stopped after producing a valid partial patch.",
      objective: "Implement resumable execution",
      workspacePath: tempDir,
      workspaceFingerprint: "fingerprint",
      artifactKeys: ["goal-1/provider-output.raw.txt"]
    }));

    expect(checkpoint.changedFiles).toContain("partial.ts");
    expect(database.getLatestGoalCheckpoint(run.id)?.id).toBe(checkpoint.id);
    expect(formatCheckpointForResume(checkpoint)).toContain("Do not revert or redo valid work");
  });

  it("checkpoint round-trip preserves all enriched semantic context fields", () => {
    const task = database.createTask("Enrich goal checkpoints with semantic context", "test", "maestro");
    database.updateTaskWorktree({
      id: task.id,
      status: "implementing",
      branchName: "task-56",
      worktreePath: tempDir
    });
    const run = database.createGoalRun(task.id);
    const step = database.createGoalStep(run.id, "implementing", "codex");
    fs.writeFileSync(path.join(tempDir, "feature.ts"), "export const feature = true;\n");

    const checkpointInput = captureGoalCheckpoint({
      runId: run.id,
      stepId: step.id,
      phase: "implementing",
      provider: "codex",
      interrupted: true,
      summary: "Partial implementation of semantic checkpoint enrichment",
      objective: "Enrich goal checkpoints with semantic context",
      done: ["Created DB schema migration", "Updated captureGoalCheckpoint"],
      decisions: ["Use JSON arrays for semantic arrays in SQLite"],
      testsRun: [{ command: "npx vitest run test/goal-checkpoint.test.ts", result: "passed" }],
      knownFailures: ["Timeout on slow integration test"],
      remaining: ["Add round-trip tests", "Validate backward compatibility"],
      workspacePath: tempDir,
      workspaceFingerprint: "fingerprint-123",
      artifactKeys: ["goal-1/step-1.txt"]
    });

    const saved = database.createGoalCheckpoint(checkpointInput);
    const retrieved = database.getGoalCheckpoint(saved.id);

    expect(retrieved.objective).toBe("Enrich goal checkpoints with semantic context");
    expect(retrieved.done).toEqual(["Created DB schema migration", "Updated captureGoalCheckpoint"]);
    expect(retrieved.decisions).toEqual(["Use JSON arrays for semantic arrays in SQLite"]);
    expect(retrieved.testsRun).toEqual([{ command: "npx vitest run test/goal-checkpoint.test.ts", result: "passed" }]);
    expect(retrieved.knownFailures).toEqual(["Timeout on slow integration test"]);
    expect(retrieved.remaining).toEqual(["Add round-trip tests", "Validate backward compatibility"]);
    expect(retrieved.changedFiles).toContain("feature.ts");
    expect(retrieved.artifactKeys).toEqual(["goal-1/step-1.txt"]);
  });

  it("formatCheckpointForResume includes semantic context in structured handoff prompt", () => {
    const checkpoint: GoalCheckpointRecord = {
      id: 42,
      runId: 10,
      stepId: 2,
      phase: "testing",
      provider: "claude",
      status: "interrupted",
      summary: "Interrupted during testing phase execution",
      objective: "Enrich goal checkpoints with semantic context",
      done: ["Implemented checkpoint schema", "Updated resume prompt formatter"],
      decisions: ["Preserve backward compatibility for missing columns"],
      testsRun: [
        { command: "npm test", result: "429 passed" }
      ],
      knownFailures: ["Network error when fetching external schema"],
      remaining: ["Verify round-trip persistence"],
      workspaceFingerprint: "fp",
      changedFiles: ["src/goals/checkpoint.ts", "src/db.ts"],
      artifactKeys: ["artifact-1.txt"],
      createdAt: new Date().toISOString()
    };

    const prompt = formatCheckpointForResume(checkpoint);
    expect(prompt).toBeDefined();
    expect(prompt).toContain("Persistent checkpoint #42 (interrupted)");
    expect(prompt).toContain("Previous provider: claude");
    expect(prompt).toContain("Previous phase: testing");
    expect(prompt).toContain("Objective: Enrich goal checkpoints with semantic context");
    expect(prompt).toContain("Summary: Interrupted during testing phase execution");
    expect(prompt).toContain("Completed work:");
    expect(prompt).toContain("- Implemented checkpoint schema");
    expect(prompt).toContain("Decisions made:");
    expect(prompt).toContain("- Preserve backward compatibility for missing columns");
    expect(prompt).toContain("Tests run:");
    expect(prompt).toContain("- [npm test]: 429 passed");
    expect(prompt).toContain("Known failures:");
    expect(prompt).toContain("- Network error when fetching external schema");
    expect(prompt).toContain("Remaining work:");
    expect(prompt).toContain("- Verify round-trip persistence");
    expect(prompt).toContain("Files present in the workspace:");
    expect(prompt).toContain("- src/goals/checkpoint.ts");
    expect(prompt).toContain("Persisted evidence:");
    expect(prompt).toContain("- artifact:artifact-1.txt");
    expect(prompt).toContain("Continue from the current workspace. Do not revert or redo valid work");
  });

  it("maintains backward compatibility with old checkpoints lacking semantic fields", () => {
    const legacyCheckpoint: GoalCheckpointRecord = {
      id: 1,
      runId: 1,
      stepId: 1,
      phase: "implementing",
      provider: "codex",
      status: "completed",
      summary: "Legacy checkpoint summary",
      workspaceFingerprint: null,
      changedFiles: [],
      artifactKeys: [],
      createdAt: new Date().toISOString()
    };

    const prompt = formatCheckpointForResume(legacyCheckpoint);
    expect(prompt).toBeDefined();
    expect(prompt).toContain("Persistent checkpoint #1 (completed)");
    expect(prompt).toContain("Summary: Legacy checkpoint summary");
    expect(prompt).toContain("Completed work:");
    expect(prompt).toContain("- no items recorded");
    expect(prompt).toContain("Decisions made:");
    expect(prompt).toContain("- no decisions recorded");
    expect(prompt).toContain("Tests run:");
    expect(prompt).toContain("- no tests recorded");
    expect(prompt).toContain("Known failures:");
    expect(prompt).toContain("- no failures recorded");
    expect(prompt).toContain("Remaining work:");
    expect(prompt).toContain("- no pending work recorded");
  });
});
