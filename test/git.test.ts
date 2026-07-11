import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktreePlan, validateGitProject } from "../src/git.js";
import { ProjectRecord, TaskRecord } from "../src/db.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-git-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("git helpers", () => {
  it("creates a deterministic worktree plan", () => {
    const project: ProjectRecord = {
      id: 1,
      key: "octomynd",
      name: "Octomynd",
      path: tempDir,
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    };
    const task: TaskRecord = {
      id: 7,
      projectId: 1,
      projectKey: "octomynd",
      projectName: "Octomynd",
      text: "melhorar resposta fora de contexto",
      status: "queued",
      source: "telegram",
      branchName: null,
      worktreePath: null,
      createdAt: "now",
      updatedAt: "now"
    };

    const plan = createWorktreePlan(project, task, path.join(tempDir, "worktrees"));

    expect(plan.branchName).toBe("maestro/task-7-melhorar-resposta-fora-de-contexto");
    expect(plan.worktreePath).toContain(path.join("worktrees", "octomynd", "task-7"));
  });

  it("rejects a non-git project", () => {
    const project: ProjectRecord = {
      id: 1,
      key: "octomynd",
      name: "Octomynd",
      path: tempDir,
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    };

    expect(validateGitProject(project)).toContain(`Project is not a Git repository: ${tempDir}`);
  });
});
