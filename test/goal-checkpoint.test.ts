import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
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
      workspacePath: tempDir,
      workspaceFingerprint: "fingerprint",
      artifactKeys: ["goal-1/provider-output.raw.txt"]
    }));

    expect(checkpoint.changedFiles).toContain("partial.ts");
    expect(database.getLatestGoalCheckpoint(run.id)?.id).toBe(checkpoint.id);
    expect(formatCheckpointForResume(checkpoint)).toContain("Nao reverta nem refaca trabalho valido");
  });
});
