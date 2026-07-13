import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoalRunRecord, ProjectRecord, TaskRecord } from "../src/db.js";
import { createGoalDeliveryHandler, scanGoalChangesForSecrets } from "../src/goals/delivery.js";
import { formatSecretScanFinding, scanWorktreePathsForSecrets } from "../src/security/secrets.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-delivery-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("goal delivery guard", () => {
  it("allows ordinary source files", () => {
    fs.writeFileSync(path.join(tempDir, "feature.ts"), "export const ready = true;\n");
    expect(scanGoalChangesForSecrets(tempDir, ["feature.ts"])).toEqual([]);
  });

  it("blocks environment files and secret-shaped content", () => {
    fs.writeFileSync(path.join(tempDir, ".env.local"), "SAFE_PLACEHOLDER=1\n");
    fs.writeFileSync(
      path.join(tempDir, "bad.txt"),
      `token=${"sk-" + "a".repeat(30)}\n`
    );

    expect(scanGoalChangesForSecrets(tempDir, [".env.local", "bad.txt"])).toEqual([
      ".env.local: sensitive filename",
      "bad.txt: secret-shaped content"
    ]);
    expect(scanWorktreePathsForSecrets(tempDir, [".env.local", "bad.txt"]).map(formatSecretScanFinding)).toEqual([
      ".env.local: sensitive filename",
      "bad.txt: secret-shaped content"
    ]);
  });

  it("commits goal changes and safely resumes from the same commit", async () => {
    git(["init"]);
    git(["config", "user.name", "Maestro Test"]);
    git(["config", "user.email", "maestro@example.invalid"]);
    fs.writeFileSync(path.join(tempDir, "README.md"), "base\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "Initial"]);
    git(["checkout", "-b", "maestro/task-4-delivery"]);
    fs.writeFileSync(path.join(tempDir, "feature.ts"), "export const delivered = true;\n");

    const project = projectRecord();
    const task = taskRecord();
    const run = goalRunRecord();
    let publishCalls = 0;
    const delivery = createGoalDeliveryHandler(async (_task, _project, commitSha) => {
      publishCalls += 1;
      expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
      return "https://github.com/example/repo/pull/4";
    });

    const first = await delivery(task, project, run);
    const second = await delivery(task, project, run);

    expect(first.commitSha).toBe(second.commitSha);
    expect(first.pullRequestUrl).toBe("https://github.com/example/repo/pull/4");
    expect(git(["status", "--porcelain"])).toBe("");
    expect(git(["log", "-1", "--pretty=%s"])).toBe("Task #4: deliver feature");
    expect(publishCalls).toBe(2);
  });
});

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: tempDir, encoding: "utf8" }).trim();
}

function projectRecord(): ProjectRecord {
  return {
    id: 1,
    key: "example",
    name: "Example",
    path: tempDir,
    defaultBranch: "main",
    createdAt: "now",
    updatedAt: "now"
  };
}

function taskRecord(): TaskRecord {
  return {
    id: 4,
    projectId: 1,
    projectKey: "example",
    projectName: "Example",
    text: "deliver feature",
    status: "reviewing",
    source: "test",
    branchName: "maestro/task-4-delivery",
    worktreePath: tempDir,
    createdAt: "now",
    updatedAt: "now"
  };
}

function goalRunRecord(): GoalRunRecord {
  return {
    id: 8,
    taskId: 4,
    status: "running",
    currentPhase: "reviewing",
    stepCount: 4,
    maxSteps: 8,
    lastError: null,
    commitSha: null,
    pullRequestUrl: null,
    createdAt: "now",
    updatedAt: "now",
    finishedAt: null
  };
}
